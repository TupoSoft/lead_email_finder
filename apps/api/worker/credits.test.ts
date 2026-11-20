import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createClient, type Row } from '@libsql/client'
import { sql, type SQL } from 'drizzle-orm'
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

type CreditAccount = { userId: string; reserved: number }
type LedgerEntry = {
    id: string
    userId: string
    operationId: string
    delta: number
    reason: string
    createdAt: number
}

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
        select user_id as userId, reserved from credit_accounts order by user_id
    `)
}

function ledgerEntries(): Promise<LedgerEntry[]> {
    return database.all<LedgerEntry>(sql`
        select id, user_id as userId, operation_id as operationId, delta, reason, created_at as createdAt
        from credit_ledger order by user_id, operation_id, id
    `)
}

async function appendCredit(userId: string, delta: number, operationId: string = randomUUID()): Promise<void> {
    await database.run(sql`
        insert into credit_ledger (id, user_id, operation_id, delta, reason, created_at)
        values (${randomUUID()}, ${userId}, ${operationId}, ${delta}, 'test_adjustment', ${Date.now()})
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
    await platform.env.DB.prepare('DROP TRIGGER IF EXISTS reject_credit_account').run()
    await platform.env.DB.prepare('DROP TRIGGER IF EXISTS reject_credit_ledger').run()
}

beforeEach(async () => {
    await clearFailureTriggers()
    await database.run(sql`delete from credit_ledger`)
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

describe('Drizzle schema synchronization', () => {
    it('preserves existing data and constraints on repeated pushes and indexed table rebuilds', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'lef-schema-sync-'))
        const databaseUrl = pathToFileURL(join(directory, 'database.sqlite')).href
        const client = createClient({ url: databaseUrl })
        const run = promisify(execFile)
        const pushSchema = (): Promise<{ stdout: string; stderr: string }> =>
            run(
                process.execPath,
                [
                    resolve(import.meta.dirname, '../node_modules/drizzle-kit/bin.cjs'),
                    'push',
                    '--dialect',
                    'sqlite',
                    '--schema',
                    'worker/database/schema.ts',
                    '--url',
                    databaseUrl,
                    '--force',
                ],
                { cwd: resolve(import.meta.dirname, '..'), timeout: 15_000 },
            )
        const seedTables = ['users', 'accounts', 'credit_accounts', 'credit_ledger']
        const readSeedRows = (): Promise<Row[][]> =>
            Promise.all(
                seedTables.map(async table => {
                    const result = await client.execute(`select * from ${table} order by 1`)

                    return result.rows
                }),
            )
        const catalogQuery = `
            select type, name, sql from sqlite_master
            where type in ('table', 'index') and name not like 'sqlite_%'
            order by type, name
        `

        try {
            await pushSchema()

            const primaryKeys = (
                await client.execute(`
                    select tables.name as table_name, columns.name as column_name, columns."notnull" as nonnull
                    from sqlite_master as tables
                    join pragma_table_info(tables.name) as columns
                    where tables.type = 'table' and tables.name not like 'sqlite_%' and columns.pk > 0
                `)
            ).rows

            assert.equal(primaryKeys.length, 7)
            assert.ok(primaryKeys.every(column => column.nonnull === 1))

            await client.execute('pragma foreign_keys = on')
            await client.batch(
                [
                    `insert into users (id, name, email, email_verified, created_at, updated_at)
                     values ('sync-user', 'Schema Sync', 'schema-sync@example.test', 1, 1000, 1000)`,
                    `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
                     values ('sync-account', 'sync-provider-account', 'google', 'sync-user', 1000, 1000)`,
                    `insert into credit_accounts (user_id, reserved, created_at, updated_at)
                     values ('sync-user', 2, 1000, 1000)`,
                    `insert into credit_ledger (id, user_id, operation_id, delta, reason, created_at)
                     values ('sync-grant', 'sync-user', 'initial-allowance', 10, 'initial_allowance', 1000)`,
                ],
                'write',
            )

            const originalRows = await readSeedRows()
            const originalCatalog = (await client.execute(catalogQuery)).rows
            const originalVersion = (await client.execute('pragma schema_version')).rows

            for (let attempt = 0; attempt < 2; attempt++) {
                const result = await pushSchema()

                assert.match(result.stdout, /No changes detected/)
                assert.deepEqual((await client.execute('pragma schema_version')).rows, originalVersion)
                assert.deepEqual((await client.execute(catalogQuery)).rows, originalCatalog)
                assert.deepEqual(await readSeedRows(), originalRows)
            }

            const accountIndexes = (
                await client.execute(`
                    select name, sql from sqlite_master
                    where type = 'index' and tbl_name = 'accounts' and sql is not null
                    order by name
                `)
            ).rows
            const accountTable = (await client.execute("select sql from sqlite_master where name = 'accounts'")).rows[0]

            assert.ok(typeof accountTable.sql === 'string')

            const nullableAccountTable = accountTable.sql
                .replace('CREATE TABLE `accounts`', 'CREATE TABLE `accounts_nullable`')
                .replace('`account_id` text NOT NULL', '`account_id` text')

            await client.execute(nullableAccountTable)
            await client.execute('insert into accounts_nullable select * from accounts')
            await client.execute('drop table accounts')
            await client.execute('alter table accounts_nullable rename to accounts')

            for (const index of accountIndexes) {
                assert.ok(typeof index.sql === 'string')

                await client.execute(index.sql)
            }

            const nullableColumns = (await client.execute('pragma table_info(accounts)')).rows

            assert.equal(nullableColumns.find(column => column.name === 'account_id')?.notnull, 0)

            const rebuilt = await pushSchema()
            const rebuiltColumns = (await client.execute('pragma table_info(accounts)')).rows

            assert.match(rebuilt.stdout, /Changes applied/)
            assert.equal(rebuiltColumns.find(column => column.name === 'account_id')?.notnull, 1)
            assert.ok(rebuiltColumns.filter(column => Number(column.pk) > 0).every(column => column.notnull === 1))
            assert.deepEqual(await readSeedRows(), originalRows)
            assert.deepEqual(
                (
                    await client.execute(`
                        select name, sql from sqlite_master
                        where type = 'index' and tbl_name = 'accounts' and sql is not null
                        order by name
                    `)
                ).rows,
                accountIndexes,
            )
            assert.deepEqual((await client.execute('pragma foreign_key_check')).rows, [])

            await assert.rejects(() =>
                client.execute(`
                    insert into credit_ledger (id, user_id, operation_id, delta, reason, created_at)
                    values ('fractional-entry', 'sync-user', 'fractional-operation', 0.5, 'test_adjustment', 1000)
                `),
            )
            await assert.rejects(() =>
                client.execute(`
                    insert into credit_ledger (id, user_id, operation_id, delta, reason, created_at)
                    values ('duplicate-entry', 'sync-user', 'initial-allowance', 1, 'test_adjustment', 1000)
                `),
            )

            assert.match((await pushSchema()).stdout, /No changes detected/)
            assert.deepEqual(await readSeedRows(), originalRows)
        } finally {
            client.close()
            await rm(directory, { recursive: true, force: true })
        }
    }, 30_000)
})

describe('tagged SQL batches on D1', () => {
    it('binds SQL-looking text verbatim and preserves regular Drizzle reads and writes', async () => {
        const { userId } = await seedSession()
        const name = "O'Brien'); delete from users; --"
        const statements: readonly SQL[] = [sql`update users set name = ${name} where id = ${userId}`]

        await database.batchSql(statements)

        const stored = await database.get<{ name: string }>(sql`select name from users where id = ${userId}`)

        assert.deepEqual(stored, { name })

        const updatedName = 'Written through Drizzle after the batch'

        await database.run(sql`update users set name = ${updatedName} where id = ${userId}`)

        assert.deepEqual(await database.all(sql`select id, name from users`), [{ id: userId, name: updatedName }])
    })

    it('executes statements in order so later writes can use earlier writes', async () => {
        const { userId } = await seedSession()
        const entryId = randomUUID()
        const now = Date.now()

        await database.batchSql([
            sql`
                insert into credit_accounts (user_id, reserved, created_at, updated_at)
                values (${userId}, 0, ${now}, ${now})
            `,
            sql`
                insert into credit_ledger (id, user_id, operation_id, delta, reason, created_at)
                select ${entryId}, user_id, 'ordered-batch', 5, 'test_adjustment', ${now}
                from credit_accounts where user_id = ${userId}
            `,
        ])

        assert.deepEqual(await accounts(), [{ userId, reserved: 0 }])
        assert.deepEqual(await ledgerEntries(), [
            { id: entryId, userId, operationId: 'ordered-batch', delta: 5, reason: 'test_adjustment', createdAt: now },
        ])
        assert.deepEqual(await credits.getSummary(userId), { balance: 5, reserved: 0, available: 5 })
    })

    it('rolls back every write when a later statement fails', async () => {
        const { userId } = await seedSession()
        const original = await database.get(sql`select name, email from users where id = ${userId}`)

        assert.ok(original)

        await assert.rejects(() =>
            database.batchSql([
                sql`update users set name = 'This change must roll back' where id = ${userId}`,
                sql`update users set email = null where id = ${userId}`,
            ]),
        )

        assert.deepEqual(await database.get(sql`select name, email from users where id = ${userId}`), original)
    })
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
    it('stores account metadata without a cached balance column', async () => {
        const columns = await database.all<{ name: string }>(sql`pragma table_info(credit_accounts)`)

        assert.ok(columns.some(column => column.name === 'reserved'))
        assert.ok(!columns.some(column => column.name === 'balance'))
    })

    it('reports zero for an account with no ledger entries', async () => {
        const { userId } = await seedSession()
        const now = Date.now()

        await database.run(sql`
            insert into credit_accounts (user_id, reserved, created_at, updated_at)
            values (${userId}, 0, ${now}, ${now})
        `)

        const summary = await credits.getSummary(userId)

        assert.deepEqual(summary, { balance: 0, reserved: 0, available: 0 })
        assert.deepEqual(await ledgerEntries(), [])
    })

    it('grants once during concurrent bootstrap and exposes only the personal summary', async () => {
        const { userId, cookie } = await seedSession()

        const responses = await Promise.all(Array.from({ length: 12 }, () => request('/v1/me', cookie)))
        const initialLedger = await ledgerEntries()

        assert.ok(responses.every(response => response.status === 200))
        assert.deepEqual(await accounts(), [{ userId, reserved: 0 }])
        assert.equal(initialLedger.length, 1)
        assert.partialDeepStrictEqual(initialLedger[0], {
            userId,
            operationId: 'initial-allowance',
            delta: 10,
            reason: 'initial_allowance',
        })

        const summary = await request('/v1/billing/summary', cookie)

        assert.equal(summary.status, 200)
        assert.equal(summary.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await summary.json(), { balance: 10, reserved: 0, available: 10 })
    })

    it('serializes competing provisioning allowances and does not repeat a grant after credits are used', async () => {
        const { userId, cookie } = await seedSession()

        await Promise.all(Array.from({ length: 16 }, (_, index) => credits.provision(userId, index + 1)))

        const originalAccounts = await accounts()
        const initialLedger = await ledgerEntries()

        assert.equal(originalAccounts.length, 1)
        assert.equal(initialLedger.length, 1)
        assert.ok(initialLedger[0].delta >= 1 && initialLedger[0].delta <= 16)
        assert.equal((await credits.getSummary(userId)).balance, initialLedger[0].delta)

        await appendCredit(userId, -initialLedger[0].delta)

        const spentLedger = await ledgerEntries()

        const retries = await Promise.all([
            request('/v1/me', cookie, '99'),
            request('/v1/billing/summary', cookie, '0'),
            request('/v1/me', cookie, '100'),
        ])

        assert.ok(retries.every(response => response.status === 200))
        assert.deepEqual(await accounts(), originalAccounts)
        assert.deepEqual(await ledgerEntries(), spentLedger)
        assert.deepEqual(await credits.getSummary(userId), { balance: 0, reserved: 0, available: 0 })
    })

    for (const failure of ['account', 'ledger'] as const) {
        it(`rolls back the entire provision when the ${failure} write fails, then repairs on bootstrap`, async () => {
            const { userId, cookie } = await seedSession()
            const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
            const trigger =
                failure === 'account'
                    ? "CREATE TRIGGER reject_credit_account BEFORE INSERT ON credit_accounts BEGIN SELECT RAISE(ABORT, 'synthetic account failure'); END"
                    : "CREATE TRIGGER reject_credit_ledger BEFORE INSERT ON credit_ledger BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END"

            await platform.env.DB.prepare(trigger).run()

            const failed = await request('/v1/me', cookie)

            assert.equal(failed.status, 500)
            assert.deepEqual(await accounts(), [])
            assert.deepEqual(await ledgerEntries(), [])
            assert.deepEqual(await failed.json(), { status: 'error' })
            assert.ok(!JSON.stringify(errorLog.mock.calls).includes('synthetic'))

            await clearFailureTriggers()

            const repaired = await request('/v1/me', cookie)

            assert.equal(repaired.status, 200)
            assert.deepEqual(await accounts(), [{ userId, reserved: 0 }])
            assert.equal((await ledgerEntries()).length, 1)
            assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 0, available: 10 })
        })
    }

    it('repairs authentication interrupted before provisioning through a summary request', async () => {
        const { userId, cookie } = await seedSession()

        assert.deepEqual(await accounts(), [])
        assert.deepEqual(await ledgerEntries(), [])

        const response = await request('/v1/billing/summary', cookie, '7')

        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { balance: 7, reserved: 0, available: 7 })
        assert.deepEqual(await accounts(), [{ userId, reserved: 0 }])
        assert.equal((await ledgerEntries()).length, 1)
        assert.partialDeepStrictEqual((await ledgerEntries())[0], { userId, delta: 7 })
    })

    it('records zero allowance durably and never grants after configuration increases', async () => {
        const { userId, cookie } = await seedSession()

        const zero = await request('/v1/me', cookie, '0')
        const originalLedger = await ledgerEntries()
        const changed = await request('/v1/billing/summary', cookie, '50')

        assert.equal(zero.status, 200)
        assert.equal(originalLedger.length, 1)
        assert.partialDeepStrictEqual(originalLedger[0], {
            userId,
            operationId: 'initial-allowance',
            delta: 0,
            reason: 'initial_allowance',
        })
        assert.equal(changed.status, 200)
        assert.deepEqual(await changed.json(), { balance: 0, reserved: 0, available: 0 })
        assert.deepEqual(await accounts(), [{ userId, reserved: 0 }])
        assert.deepEqual(await ledgerEntries(), originalLedger)
    })

    it('scopes balances to the authenticated user and ignores attempted user selection', async () => {
        const first = await seedSession()
        const second = await seedSession()

        await credits.provision(first.userId, 20)
        await credits.provision(second.userId, 3)
        await appendCredit(first.userId, 8)
        await appendCredit(first.userId, -5)
        await appendCredit(second.userId, -2)
        await database.run(sql`update credit_accounts set reserved = 4 where user_id = ${first.userId}`)

        const firstResponse = await request(`/v1/billing/summary?userId=${second.userId}`, first.cookie)
        const secondResponse = await request(`/v1/billing/summary?userId=${first.userId}`, second.cookie)

        assert.equal(firstResponse.status, 200)
        assert.equal(secondResponse.status, 200)
        assert.deepEqual(await firstResponse.json(), { balance: 23, reserved: 4, available: 19 })
        assert.deepEqual(await secondResponse.json(), { balance: 1, reserved: 0, available: 1 })
        assert.equal((await accounts()).length, 2)
        assert.equal((await ledgerEntries()).length, 5)
    })

    it('enforces operation uniqueness within each user account', async () => {
        const first = await seedSession()
        const second = await seedSession()
        const operationId = 'shared-operation-reference'

        await credits.provision(first.userId, 10)
        await credits.provision(second.userId, 10)
        await appendCredit(first.userId, 4, operationId)
        await appendCredit(second.userId, 7, operationId)

        await assert.rejects(() => appendCredit(first.userId, 999, operationId))

        assert.deepEqual(await credits.getSummary(first.userId), { balance: 14, reserved: 0, available: 14 })
        assert.deepEqual(await credits.getSummary(second.userId), { balance: 17, reserved: 0, available: 17 })
        assert.equal((await ledgerEntries()).length, 4)
    })

    it('deletes only the removed user’s account and ledger', async () => {
        const first = await seedSession()
        const second = await seedSession()

        await credits.provision(first.userId, 10)
        await credits.provision(second.userId, 20)
        await appendCredit(second.userId, -4)

        const remainingLedger = (await ledgerEntries()).filter(entry => entry.userId === second.userId)

        await database.run(sql`delete from users where id = ${first.userId}`)

        assert.deepEqual(await accounts(), [{ userId: second.userId, reserved: 0 }])
        assert.deepEqual(await ledgerEntries(), remainingLedger)
        assert.deepEqual(await database.all(sql`pragma foreign_key_check`), [])

        const removed = await request('/v1/billing/summary', first.cookie)
        const remaining = await request('/v1/billing/summary', second.cookie)

        assert.equal(removed.status, 401)
        assert.equal(remaining.status, 200)
        assert.deepEqual(await remaining.json(), { balance: 16, reserved: 0, available: 16 })
    })

    const invalidTotals = [
        { name: 'negative balance', allowance: 10, adjustment: -11, reserved: 0 },
        { name: 'unsafe integer balance', allowance: Number.MAX_SAFE_INTEGER, adjustment: 1, reserved: 0 },
        { name: 'reserved credits exceeding the balance', allowance: 10, adjustment: -8, reserved: 3 },
    ]

    for (const { name, allowance, adjustment, reserved } of invalidTotals) {
        it(`fails closed when the ledger produces ${name}`, async () => {
            const { userId, cookie } = await seedSession()
            vi.spyOn(console, 'error').mockImplementation(() => undefined)

            await credits.provision(userId, allowance)
            await appendCredit(userId, adjustment)
            await database.run(sql`update credit_accounts set reserved = ${reserved} where user_id = ${userId}`)

            const originalLedger = await ledgerEntries()

            await assert.rejects(() => credits.getSummary(userId))

            const response = await request('/v1/billing/summary', cookie)

            assert.equal(response.status, 500)
            assert.deepEqual(await response.json(), { status: 'error' })
            assert.deepEqual(await ledgerEntries(), originalLedger)
        })
    }

    it('fails closed when SQLite cannot represent the ledger aggregate', async () => {
        const { userId, cookie } = await seedSession()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)

        await credits.provision(userId, 10)
        await database.run(sql`
            with recursive entries(number) as (
                select 1
                union all
                select number + 1 from entries where number < 1025
            )
            insert into credit_ledger (id, user_id, operation_id, delta, reason, created_at)
            select 'overflow-entry-' || number, ${userId}, 'overflow-operation-' || number,
                ${Number.MAX_SAFE_INTEGER}, 'test_adjustment', ${Date.now()}
            from entries
        `)

        await assert.rejects(() => credits.getSummary(userId))

        const response = await request('/v1/billing/summary', cookie)
        const entries = await ledgerEntries()

        assert.equal(response.status, 500)
        assert.deepEqual(await response.json(), { status: 'error' })
        assert.equal(entries.filter(entry => entry.operationId === 'initial-allowance').length, 1)
        assert.equal(entries.length, 1026)
    })

    for (const initialAllowance of [10, 0]) {
        it(`recreates a missing account without repeating its ${initialAllowance}-credit initial grant`, async () => {
            const { userId, cookie } = await seedSession()

            await credits.provision(userId, initialAllowance)

            if (initialAllowance > 0) {
                await appendCredit(userId, -7)
            }

            const originalLedger = await ledgerEntries()
            const remainingBalance = initialAllowance > 0 ? initialAllowance - 7 : 0

            await database.run(sql`delete from credit_accounts where user_id = ${userId}`)

            assert.deepEqual(await accounts(), [])
            assert.deepEqual(await ledgerEntries(), originalLedger)
            await assert.rejects(() => credits.getSummary(userId))

            const responses = await Promise.all([
                request('/v1/me', cookie, '99'),
                request('/v1/billing/summary', cookie, '99'),
            ])

            assert.ok(responses.every(response => response.status === 200))
            assert.deepEqual(await accounts(), [{ userId, reserved: 0 }])
            assert.deepEqual(await ledgerEntries(), originalLedger)
            assert.deepEqual(await credits.getSummary(userId), {
                balance: remainingBalance,
                reserved: 0,
                available: remainingBalance,
            })
        })
    }

    it('rejects fractional and unsafe signed ledger deltas at the database boundary', async () => {
        const { userId } = await seedSession()

        await credits.provision(userId, 10)

        for (const delta of [0.5, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1]) {
            await assert.rejects(() => appendCredit(userId, delta))
        }

        assert.equal((await ledgerEntries()).length, 1)
        assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 0, available: 10 })
    })

    it('denies unauthenticated and unverified callers without provisioning accounts or grants', async () => {
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
        assert.deepEqual(await ledgerEntries(), [])
    })

    it('requires persisted email verification even when provisioning is called without HTTP middleware', async () => {
        const { userId } = await seedSession(false)

        await credits.provision(userId, 10)
        await credits.provision(randomUUID(), 10)

        assert.deepEqual(await accounts(), [])
        assert.deepEqual(await ledgerEntries(), [])
        await assert.rejects(() => credits.getSummary(userId))
    })
})
