import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import { ZodError } from 'zod'
import app from './app'
import { createAuth } from './auth'
import { authConfigurationSchema, type WorkerEnvironment } from './environment'
import { D1CreditAccountsRepository } from '@/adapters/outbound/d1-credit-accounts-repository'
import { createDatabase, type Database } from '@/database/connection'

const origin = 'http://localhost:53000'
const secret = 'test-only-better-auth-secret-at-least-thirty-two-characters'

type CreditAccount = { userId: string; balance: number; reserved: number }
type ProvisioningReceipt = { userId: string; id: string; allowance: number }

let platform: PlatformProxy<Pick<Env, 'DB' | 'AUTH_EMAIL' | 'AUTH_MAIL_FROM'>>
let database: Database
let credits: D1CreditAccountsRepository

function environment(allowance = '10'): WorkerEnvironment['Bindings'] {
    return {
        ...platform.env,
        APP_BASE_URL: origin,
        BETTER_AUTH_SECRET: secret,
        GOOGLE_CLIENT_ID: 'test-google-client-id',
        GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
        INITIAL_CREDIT_ALLOWANCE: allowance,
    }
}

async function request(path: string, cookie?: string, allowance?: string): Promise<Response> {
    return app.request(
        new Request(`${origin}${path}`, { headers: cookie ? { Cookie: cookie } : {} }),
        undefined,
        environment(allowance),
    )
}

async function seedSession(verified = true): Promise<{ userId: string; cookie: string }> {
    const userId = randomUUID()
    const token = randomUUID()
    const now = Date.now()
    const signature = createHmac('sha256', secret).update(token).digest('base64')

    await database.run(sql`
        insert into users (id, name, email, email_verified, created_at, updated_at)
        values (${userId}, 'Credit Test', ${`${userId}@example.test`}, ${Number(verified)}, ${now}, ${now})
    `)
    await database.run(sql`
        insert into sessions (id, user_id, token, expires_at, created_at, updated_at)
        values (${randomUUID()}, ${userId}, ${token}, ${now + 86_400_000}, ${now}, ${now})
    `)

    return { userId, cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` }
}

function accounts(): Promise<CreditAccount[]> {
    return database.all<CreditAccount>(sql`
        select user_id as userId, balance, reserved from credit_accounts order by user_id
    `)
}

function receipts(): Promise<ProvisioningReceipt[]> {
    return database.all<ProvisioningReceipt>(sql`
        select user_id as userId, id, allowance from credit_provisioning_receipts order by user_id
    `)
}

beforeAll(async () => {
    platform = await getPlatformProxy<Pick<Env, 'DB' | 'AUTH_EMAIL' | 'AUTH_MAIL_FROM'>>({
        configPath: resolve(import.meta.dirname, '../wrangler.jsonc'),
        persist: { path: resolve(import.meta.dirname, '../.wrangler/state/test/v3') },
        remoteBindings: false,
        envFiles: [],
    })
    database = createDatabase(platform.env.DB)
    credits = new D1CreditAccountsRepository(database)
})

afterAll(async () => {
    await platform?.dispose()
})

async function clearFailureTriggers(): Promise<void> {
    await platform.env.DB.prepare('DROP TRIGGER IF EXISTS reject_credit_receipt').run()
    await platform.env.DB.prepare('DROP TRIGGER IF EXISTS reject_credit_balance').run()
}

beforeEach(async () => {
    await clearFailureTriggers()
    await database.run(sql`delete from credit_provisioning_receipts`)
    await database.run(sql`delete from credit_accounts`)
    await database.run(sql`delete from sessions`)
    await database.run(sql`delete from accounts`)
    await database.run(sql`delete from users`)
    await database.run(sql`delete from verifications`)
    await database.run(sql`delete from auth_rate_limits`)
})

afterEach(async () => {
    await clearFailureTriggers()
    vi.restoreAllMocks()
})

describe('initial credit allowance configuration', () => {
    it('requires an explicitly configured allowance', () => {
        const configuration = environment()
        Reflect.deleteProperty(configuration, 'INITIAL_CREDIT_ALLOWANCE')

        const result = authConfigurationSchema.safeParse(configuration)

        assert.equal(result.success, false)
        assert.ok(result.error)
        assert.deepEqual(
            result.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
            [
                {
                    path: ['INITIAL_CREDIT_ALLOWANCE'],
                    message: 'INITIAL_CREDIT_ALLOWANCE must be explicitly configured.',
                },
            ],
        )
    })

    for (const baseUrl of [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://[::1]:5173',
        'https://app.example.test',
        'http://app.example.test',
        'https://localhost:5173',
    ]) {
        it(`rejects authentication setup without an explicit allowance: ${baseUrl}`, () => {
            const configuration = { ...environment(), APP_BASE_URL: baseUrl }
            Reflect.deleteProperty(configuration, 'INITIAL_CREDIT_ALLOWANCE')

            assert.throws(
                () => createAuth(database, configuration),
                (error: unknown) => {
                    assert.ok(error instanceof ZodError)
                    assert.deepEqual(
                        error.issues.map(issue => ({ path: issue.path, message: issue.message })),
                        [
                            {
                                path: ['INITIAL_CREDIT_ALLOWANCE'],
                                message: 'INITIAL_CREDIT_ALLOWANCE must be explicitly configured.',
                            },
                        ],
                    )

                    return true
                },
            )
        })
    }

    it('accepts explicit zero and a positive allowance', () => {
        assert.equal(authConfigurationSchema.parse(environment('0')).INITIAL_CREDIT_ALLOWANCE, 0)
        assert.equal(authConfigurationSchema.parse(environment('25')).INITIAL_CREDIT_ALLOWANCE, 25)
    })

    for (const allowance of ['', ' ', '-1', '1.5', '1e3', 'Infinity', 'NaN', '9007199254740992']) {
        it(`rejects an invalid configured allowance: ${JSON.stringify(allowance)}`, () => {
            const result = authConfigurationSchema.safeParse(environment(allowance))

            assert.equal(result.success, false)
            assert.ok(result.error)
            assert.deepEqual(
                result.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
                [
                    {
                        path: ['INITIAL_CREDIT_ALLOWANCE'],
                        message: 'INITIAL_CREDIT_ALLOWANCE must be a nonnegative safe integer.',
                    },
                ],
            )
        })
    }
})

describe('durable personal credit provisioning on D1', () => {
    it('grants once during concurrent bootstrap and exposes only the personal summary', async () => {
        const { userId, cookie } = await seedSession()

        const responses = await Promise.all(Array.from({ length: 12 }, () => request('/v1/me', cookie)))

        assert.ok(responses.every(response => response.status === 200))
        assert.deepEqual(await accounts(), [{ userId, balance: 10, reserved: 0 }])
        assert.equal((await receipts()).length, 1)
        assert.partialDeepStrictEqual((await receipts())[0], { userId, allowance: 10 })

        const summary = await request('/v1/billing/summary', cookie)

        assert.equal(summary.status, 200)
        assert.equal(summary.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await summary.json(), { balance: 10, reserved: 0, available: 10 })
    })

    it('serializes competing provisioning allowances and does not repeat a grant after credits are used', async () => {
        const { userId, cookie } = await seedSession()

        await Promise.all(Array.from({ length: 16 }, (_, index) => credits.provision(userId, index + 1)))

        const originalReceipts = await receipts()
        const originalAccounts = await accounts()

        assert.equal(originalReceipts.length, 1)
        assert.equal(originalAccounts.length, 1)
        assert.equal(originalAccounts[0].balance, originalReceipts[0].allowance)

        await database.run(sql`update credit_accounts set balance = 0 where user_id = ${userId}`)

        const retries = await Promise.all([
            request('/v1/me', cookie, '99'),
            request('/v1/billing/summary', cookie, '0'),
            request('/v1/me', cookie, '100'),
        ])

        assert.ok(retries.every(response => response.status === 200))
        assert.deepEqual(await receipts(), originalReceipts)
        assert.deepEqual(await accounts(), [{ userId, balance: 0, reserved: 0 }])
    })

    for (const failure of ['receipt', 'balance'] as const) {
        it(`rolls back the entire provision when the ${failure} write fails, then repairs on bootstrap`, async () => {
            const { userId, cookie } = await seedSession()
            const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
            const trigger =
                failure === 'receipt'
                    ? "CREATE TRIGGER reject_credit_receipt BEFORE INSERT ON credit_provisioning_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END"
                    : "CREATE TRIGGER reject_credit_balance BEFORE UPDATE OF balance ON credit_accounts BEGIN SELECT RAISE(ABORT, 'synthetic balance failure'); END"

            await platform.env.DB.prepare(trigger).run()

            const failed = await request('/v1/me', cookie)

            assert.equal(failed.status, 500)
            assert.deepEqual(await accounts(), [])
            assert.deepEqual(await receipts(), [])
            assert.deepEqual(await failed.json(), { status: 'error' })
            assert.ok(!JSON.stringify(errorLog.mock.calls).includes('synthetic'))

            await clearFailureTriggers()

            const repaired = await request('/v1/me', cookie)

            assert.equal(repaired.status, 200)
            assert.deepEqual(await accounts(), [{ userId, balance: 10, reserved: 0 }])
            assert.equal((await receipts()).length, 1)
        })
    }

    it('repairs authentication interrupted before provisioning through a summary request', async () => {
        const { userId, cookie } = await seedSession()

        assert.deepEqual(await accounts(), [])
        assert.deepEqual(await receipts(), [])

        const response = await request('/v1/billing/summary', cookie, '7')

        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { balance: 7, reserved: 0, available: 7 })
        assert.deepEqual(await accounts(), [{ userId, balance: 7, reserved: 0 }])
        assert.partialDeepStrictEqual((await receipts())[0], { userId, allowance: 7 })
    })

    it('records zero allowance durably and never grants after configuration increases', async () => {
        const { userId, cookie } = await seedSession()

        const zero = await request('/v1/me', cookie, '0')
        const originalReceipts = await receipts()
        const changed = await request('/v1/billing/summary', cookie, '50')

        assert.equal(zero.status, 200)
        assert.equal(originalReceipts.length, 1)
        assert.partialDeepStrictEqual(originalReceipts[0], { userId, allowance: 0 })
        assert.equal(changed.status, 200)
        assert.deepEqual(await changed.json(), { balance: 0, reserved: 0, available: 0 })
        assert.deepEqual(await accounts(), [{ userId, balance: 0, reserved: 0 }])
        assert.deepEqual(await receipts(), originalReceipts)
    })

    it('scopes balances to the authenticated user and ignores attempted user selection', async () => {
        const first = await seedSession()
        const second = await seedSession()

        await credits.provision(first.userId, 20)
        await credits.provision(second.userId, 3)
        await database.run(sql`update credit_accounts set reserved = 4 where user_id = ${first.userId}`)

        const firstResponse = await request(`/v1/billing/summary?userId=${second.userId}`, first.cookie)
        const secondResponse = await request(`/v1/billing/summary?userId=${first.userId}`, second.cookie)

        assert.equal(firstResponse.status, 200)
        assert.equal(secondResponse.status, 200)
        assert.deepEqual(await firstResponse.json(), { balance: 20, reserved: 4, available: 16 })
        assert.deepEqual(await secondResponse.json(), { balance: 3, reserved: 0, available: 3 })
        assert.equal((await accounts()).length, 2)
        assert.equal((await receipts()).length, 2)
    })

    it('denies unauthenticated and unverified callers without provisioning accounts or receipts', async () => {
        const { cookie } = await seedSession(false)

        const missing = await request('/v1/billing/summary')
        const unverified = await request('/v1/billing/summary', cookie)
        const bootstrap = await request('/v1/me', cookie)

        assert.equal(missing.status, 401)
        assert.equal(unverified.status, 403)
        assert.equal(bootstrap.status, 403)
        assert.equal(missing.headers.get('cache-control'), 'no-store')
        assert.equal(unverified.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await accounts(), [])
        assert.deepEqual(await receipts(), [])
    })

    it('requires persisted email verification even when provisioning is called without HTTP middleware', async () => {
        const { userId } = await seedSession(false)

        await credits.provision(userId, 10)
        await credits.provision(randomUUID(), 10)

        assert.deepEqual(await accounts(), [])
        assert.deepEqual(await receipts(), [])
        await assert.rejects(() => credits.getSummary(userId))
    })
})
