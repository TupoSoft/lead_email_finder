import assert from 'node:assert/strict'
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest'
import { createHmac, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import { ZodError } from 'zod'
import app from './app'
import { createAuth, requireApplicationMutation, requireVerifiedUser } from './auth'
import { environmentSchema, type WorkerEnvironment } from './environment'
import { createDatabase, type Database } from '@/database/connection'
import { account, rateLimit, session, user, verification } from '@/database/schema'

const origin = 'http://localhost:53000'
const secret = 'test-only-better-auth-secret-at-least-thirty-two-characters'
const day = 24 * 60 * 60 * 1000

let platform: PlatformProxy<Pick<Env, 'DB' | 'AUTH_EMAIL' | 'AUTH_MAIL_FROM' | 'INITIAL_CREDIT_ALLOWANCE'>>
let database: Database

function environment(baseUrl = origin): WorkerEnvironment['Bindings'] {
    return {
        ...platform.env,
        APP_BASE_URL: baseUrl,
        BETTER_AUTH_SECRET: secret,
        GOOGLE_CLIENT_ID: 'test-google-client-id',
        GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    }
}

function signedCookie(token: string, baseUrl = origin): string {
    const prefix = baseUrl.startsWith('https:') ? '__Secure-' : ''
    const signature = createHmac('sha256', secret).update(token).digest('base64')

    return `${prefix}better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
}

async function seedSession(options: { age?: number; verified?: boolean; expiresAt?: Date } = {}): Promise<{
    currentUser: typeof user.$inferSelect
    currentSession: typeof session.$inferSelect
    cookie: string
}> {
    const now = Date.now()
    const createdAt = new Date(now - (options.age ?? 0))
    const currentUser = {
        id: randomUUID(),
        name: 'Session Test',
        email: `${randomUUID()}@example.test`,
        emailVerified: options.verified ?? true,
        image: null,
        createdAt,
        updatedAt: createdAt,
    }
    const currentSession = {
        id: randomUUID(),
        token: randomUUID(),
        userId: currentUser.id,
        expiresAt: options.expiresAt ?? new Date(createdAt.getTime() + 7 * day),
        ipAddress: '192.0.2.10',
        userAgent: 'Synthetic private user agent',
        createdAt,
        updatedAt: createdAt,
    }

    await database.insert(user).values(currentUser)
    await database.insert(session).values(currentSession)

    return { currentUser, currentSession, cookie: signedCookie(currentSession.token) }
}

async function request(path: string, options: RequestInit = {}, baseUrl = origin): Promise<Response> {
    return app.request(new Request(`${baseUrl}${path}`, options), undefined, environment(baseUrl))
}

beforeAll(async () => {
    platform = await getPlatformProxy<Pick<Env, 'DB' | 'AUTH_EMAIL' | 'AUTH_MAIL_FROM' | 'INITIAL_CREDIT_ALLOWANCE'>>({
        configPath: resolve(import.meta.dirname, '../wrangler.jsonc'),
        persist: { path: resolve(import.meta.dirname, '../.wrangler/state/test/v3') },
        remoteBindings: false,
        envFiles: [],
    })
    database = createDatabase(platform.env.DB)
})

afterAll(async () => {
    await platform?.dispose()
})

beforeEach(async () => {
    await platform.env.DB.prepare('DROP TRIGGER IF EXISTS reject_session_deletion').run()
    await database.delete(session)
    await database.delete(account)
    await database.delete(user)
    await database.delete(verification)
    await database.delete(rateLimit)
})

describe('Worker startup configuration errors', () => {
    beforeEach(() => {
        vi.resetModules()
    })

    afterEach(() => {
        vi.doUnmock('cloudflare:workers')
        vi.resetModules()
        vi.restoreAllMocks()
    })

    it('starts with valid bindings and exports a working handler without configuration errors', async () => {
        const configuration = environment()
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        vi.doMock('cloudflare:workers', () => ({ env: configuration }))

        const worker = await import('./index')
        const response = await worker.default.request('/health', undefined, configuration)

        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { status: 'ok', d1: 'up' })
        assert.deepEqual(errorLog.mock.calls, [])
    })

    it('aborts startup with readable field errors and structured logs without exposing private values', async () => {
        const configuration = {
            ...environment(),
            APP_BASE_URL: 'https://private-user:private-password@app.example.test/private-url',
            BETTER_AUTH_SECRET: 'private-short-secret',
            GOOGLE_CLIENT_SECRET: { privateCredential: 'private-google-secret' },
            INITIAL_CREDIT_ALLOWANCE: 'private-allowance',
            AUTH_MAIL_FROM: 'private-sender@example.test\r\nBcc: private-recipient@example.test',
            AUTH_EMAIL: { send: 'private-binding-value' },
        }
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const issues = [
            { field: 'APP_BASE_URL', message: 'APP_BASE_URL must be an HTTP(S) origin.' },
            { field: 'BETTER_AUTH_SECRET', message: 'BETTER_AUTH_SECRET must contain at least 32 characters.' },
            {
                field: 'GOOGLE_CLIENT_SECRET',
                message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be configured.',
            },
            {
                field: 'INITIAL_CREDIT_ALLOWANCE',
                message: 'INITIAL_CREDIT_ALLOWANCE must be a nonnegative safe integer.',
            },
            {
                field: 'AUTH_MAIL_FROM',
                message: 'AUTH_MAIL_FROM must be a single email address, optionally with a display name.',
            },
            { field: 'AUTH_EMAIL', message: 'AUTH_EMAIL must be an Email Service send binding.' },
        ]

        vi.doMock('cloudflare:workers', () => ({ env: configuration }))

        await assert.rejects(
            () => import('./index'),
            (error: unknown) => {
                assert.ok(error instanceof Error)
                assert.equal(error.name, 'Error')
                assert.equal(
                    error.message,
                    `Invalid Worker configuration:\n${issues.map(issue => `${issue.field}: ${issue.message}`).join('\n')}`,
                )
                assert.ok(error.cause instanceof ZodError)
                assert.ok(!error.message.includes('private-'))
                assert.ok(!JSON.stringify(error.cause).includes('private-'))

                return true
            },
        )

        assert.deepEqual(errorLog.mock.calls, [[{ event: 'invalid_worker_configuration', issues }]])
        assert.ok(!JSON.stringify(errorLog.mock.calls).includes('private-'))
    })

    it('preserves unexpected binding access failures instead of presenting them as validation errors', async () => {
        const failure = new Error('Synthetic binding access failure')
        const configuration = {
            ...environment(),
            get APP_BASE_URL(): string {
                throw failure
            },
        }
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        vi.doMock('cloudflare:workers', () => ({ env: configuration }))

        await assert.rejects(
            () => import('./index'),
            (error: unknown) => error === failure,
        )

        assert.deepEqual(errorLog.mock.calls, [])
    })
})

describe('Worker environment schema', () => {
    it('normalizes the origin, numeric allowance, and structured mail sender together', () => {
        const configuration = {
            ...environment('https://app.example.test/'),
            INITIAL_CREDIT_ALLOWANCE: '25',
            AUTH_MAIL_FROM: 'Lead Email Finder <no-reply@example.test>',
        }

        const parsed = environmentSchema.parse(configuration)

        assert.equal(parsed.APP_BASE_URL, 'https://app.example.test')
        assert.equal(parsed.INITIAL_CREDIT_ALLOWANCE, 25)
        assert.deepEqual(parsed.AUTH_MAIL_FROM, { name: 'Lead Email Finder', email: 'no-reply@example.test' })
        assert.equal(parsed.AUTH_EMAIL, configuration.AUTH_EMAIL)
        assert.equal(parsed.BETTER_AUTH_SECRET, secret)
    })

    it('preserves explicit zero allowance and a plain email sender', () => {
        const parsed = environmentSchema.parse({
            ...environment(),
            INITIAL_CREDIT_ALLOWANCE: '0',
            AUTH_MAIL_FROM: 'no-reply@example.test',
        })

        assert.equal(parsed.INITIAL_CREDIT_ALLOWANCE, 0)
        assert.equal(parsed.AUTH_MAIL_FROM, 'no-reply@example.test')
    })

    const invalidVariables: { field: string; values: unknown[]; message: string }[] = [
        {
            field: 'APP_BASE_URL',
            values: [
                undefined,
                '',
                'private-invalid-url',
                'ftp://app.example.test',
                'https://name:password@app.example.test',
                'https://app.example.test/path',
                'https://app.example.test/?private=query',
                'https://app.example.test/#private-fragment',
            ],
            message: 'APP_BASE_URL must be an HTTP(S) origin.',
        },
        {
            field: 'BETTER_AUTH_SECRET',
            values: [undefined, null, 42, '', 'private-short-secret'],
            message: 'BETTER_AUTH_SECRET must contain at least 32 characters.',
        },
        ...(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const).map(field => ({
            field,
            values: [undefined, null, 42, '', '   '],
            message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be configured.',
        })),
        {
            field: 'AUTH_MAIL_FROM',
            values: [undefined],
            message: 'AUTH_MAIL_FROM must be a single email address, optionally with a display name.',
        },
        {
            field: 'AUTH_EMAIL',
            values: [undefined],
            message: 'AUTH_EMAIL must be an Email Service send binding.',
        },
    ]

    for (const { field, values, message } of invalidVariables) {
        it(`rejects missing or invalid ${field} with a fixed, field-specific issue`, () => {
            for (const value of values) {
                const configuration: Record<string, unknown> = { ...environment(), [field]: value }
                const result = environmentSchema.safeParse(configuration)

                assert.equal(result.success, false)
                assert.ok(result.error)
                assert.deepEqual(
                    result.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
                    [{ path: [field], message }],
                )
            }
        })
    }

    it('keeps invalid credentials, sender details, and URL contents out of configuration errors', () => {
        const configuration = {
            ...environment(),
            APP_BASE_URL: 'https://private-user:private-password@app.example.test/private-path?private-query',
            BETTER_AUTH_SECRET: 'private-short-secret',
            GOOGLE_CLIENT_SECRET: { privateCredential: 'private-google-secret' },
            INITIAL_CREDIT_ALLOWANCE: 'private-allowance',
            AUTH_MAIL_FROM: 'private-sender@example.test\r\nBcc: private-recipient@example.test',
            AUTH_EMAIL: { send: 'private-binding-value' },
        }

        const result = environmentSchema.safeParse(configuration)

        assert.equal(result.success, false)
        assert.ok(result.error)
        assert.deepEqual(result.error.issues.map(issue => issue.path[0]).sort(), [
            'APP_BASE_URL',
            'AUTH_EMAIL',
            'AUTH_MAIL_FROM',
            'BETTER_AUTH_SECRET',
            'GOOGLE_CLIENT_SECRET',
            'INITIAL_CREDIT_ALLOWANCE',
        ])
        assert.ok(!result.error.message.includes('private-'))
        assert.ok(!JSON.stringify(result.error).includes('private-'))
        assert.ok(result.error.issues.every(issue => !('input' in issue)))
    })
})

describe('D1 Better Auth sessions', () => {
    for (const field of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const) {
        for (const value of [undefined, '', '   ']) {
            it(`rejects missing or empty Google configuration: ${field}=${value}`, () => {
                const configuration = environment()

                if (value === undefined) {
                    Reflect.deleteProperty(configuration, field)
                } else {
                    configuration[field] = value
                }

                assert.throws(
                    () => createAuth(database, configuration),
                    (error: unknown) => {
                        assert.ok(error instanceof ZodError)
                        assert.deepEqual(
                            error.issues.map(issue => ({ path: issue.path, message: issue.message })),
                            [
                                {
                                    path: [field],
                                    message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be configured.',
                                },
                            ],
                        )

                        return true
                    },
                )
            })
        }
    }

    it('reads a sanitized verified user without exposing credential or storage metadata', async () => {
        const { currentUser, currentSession, cookie } = await seedSession()

        const response = await request('/v1/me', { headers: { cookie } })

        assert.equal(response.status, 200)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await response.json(), {
            user: {
                id: currentUser.id,
                name: currentUser.name,
                email: currentUser.email,
                emailVerified: true,
                image: null,
            },
        })
        assert.deepEqual(response.headers.getSetCookie(), [])
        assert.deepEqual(
            await database.select().from(session).where(eq(session.id, currentSession.id)).get(),
            currentSession,
        )
    })

    it('renews a session after one day and preserves every refresh cookie on the sanitized response', async () => {
        const { currentSession, cookie } = await seedSession({ age: day + 1000 })
        const before = Date.now()

        const response = await request('/v1/me', { headers: { cookie } })
        const refreshed = await database.select().from(session).where(eq(session.id, currentSession.id)).get()

        assert.equal(response.status, 200)
        assert.ok(refreshed)
        assert.ok(refreshed.expiresAt.getTime() >= before + 7 * day)
        assert.ok(refreshed.expiresAt.getTime() <= Date.now() + 7 * day)
        assert.ok(refreshed.updatedAt.getTime() >= before)

        const cookies = response.headers.getSetCookie()
        const tokenCookie = cookies.find(value => value.startsWith('better-auth.session_token='))

        assert.ok(tokenCookie)
        assert.ok(tokenCookie.includes('Max-Age=604800'))
        assert.ok(tokenCookie.includes('HttpOnly'))
        assert.ok(tokenCookie.includes('SameSite=Lax'))
        assert.ok(tokenCookie.includes('Path=/'))
        assert.ok(!tokenCookie.includes('; Secure'))
        assert.equal(
            cookies.some(value => value.includes('session_data=') && !value.includes('Max-Age=0')),
            false,
        )
        assert.ok(!(await response.text()).includes(currentSession.token))
    })

    it('does not renew before the daily interval', async () => {
        const { currentSession, cookie } = await seedSession({ age: day - 60_000 })

        const response = await request('/v1/me', { headers: { cookie } })
        const unchanged = await database.select().from(session).where(eq(session.id, currentSession.id)).get()

        assert.equal(response.status, 200)
        assert.deepEqual(response.headers.getSetCookie(), [])
        assert.deepEqual(unchanged?.expiresAt, currentSession.expiresAt)
    })

    it('preserves both session renewal and stale cookie-cache cleanup headers', async () => {
        const { cookie } = await seedSession({ age: day + 1000 })

        const response = await request('/v1/me', {
            headers: { cookie: `${cookie}; better-auth.session_data=stale-cache` },
        })
        const cookies = response.headers.getSetCookie()

        assert.equal(response.status, 200)
        assert.ok(cookies.some(value => /session_token=.*Max-Age=604800/.test(value)))
        assert.ok(cookies.some(value => /session_data=.*Max-Age=0/.test(value)))
    })

    it('preserves refresh cookies when verified-user authorization rejects the session', async () => {
        const { cookie } = await seedSession({ age: day + 1000, verified: false })

        const response = await request('/v1/me', { headers: { cookie } })

        assert.equal(response.status, 403)
        assert.deepEqual(await response.json(), { code: 'email_verification_required' })
        assert.ok(response.headers.getSetCookie().some(value => /session_token=.*Max-Age=604800/.test(value)))
    })

    it('uses a Secure HttpOnly SameSite=Lax session cookie over HTTPS', async () => {
        const { currentSession } = await seedSession({ age: day + 1000 })
        const baseUrl = 'https://app.example.test'

        const response = await request(
            '/v1/me',
            { headers: { cookie: signedCookie(currentSession.token, baseUrl) } },
            baseUrl,
        )
        const tokenCookie = response.headers.getSetCookie().find(value => value.includes('session_token='))

        assert.equal(response.status, 200)
        assert.ok(tokenCookie)
        assert.match(tokenCookie, /^__Secure-better-auth\.session_token=/)
        assert.ok(tokenCookie.includes('; Secure'))
        assert.ok(tokenCookie.includes('HttpOnly'))
        assert.ok(tokenCookie.includes('SameSite=Lax'))
    })

    it('rejects expiry and forwards cookie deletion while removing the expired database session', async () => {
        const { currentSession, cookie } = await seedSession({ expiresAt: new Date(Date.now() - 1000) })

        const response = await request('/v1/me', { headers: { cookie } })

        assert.equal(response.status, 401)
        assert.deepEqual(await response.json(), { code: 'authentication_required' })
        assert.equal(
            response.headers.getSetCookie().some(value => /session_token=.*Max-Age=0/.test(value)),
            true,
        )
        assert.equal(await database.select().from(session).where(eq(session.id, currentSession.id)).get(), undefined)
    })

    it('checks D1 on every request so revocation immediately rejects an existing cookie', async () => {
        const { currentSession, cookie } = await seedSession()

        assert.equal((await request('/v1/me', { headers: { cookie } })).status, 200)
        await database.delete(session).where(eq(session.id, currentSession.id))

        const response = await request('/v1/me', { headers: { cookie } })

        assert.equal(response.status, 401)
        assert.deepEqual(await response.json(), { code: 'authentication_required' })
    })

    it('rejects missing and tampered cookies, and denies unverified users', async () => {
        const { cookie } = await seedSession({ verified: false })

        const missing = await request('/v1/me')
        const tampered = await request('/v1/me', { headers: { cookie: `${cookie}tampered` } })
        const unverified = await request('/v1/me', { headers: { cookie } })

        assert.equal(missing.status, 401)
        assert.equal(tampered.status, 401)
        assert.equal(unverified.status, 403)
        assert.deepEqual(await unverified.json(), { code: 'email_verification_required' })
    })

    it('maps account and verification models through the SQLite adapter', async () => {
        const { currentUser } = await seedSession()
        const auth = createAuth(database, environment())
        const context = await auth.$context
        const accountId = randomUUID()
        const verificationId = randomUUID()
        const now = new Date()

        await context.adapter.create({
            model: 'account',
            data: {
                id: accountId,
                accountId: 'provider-subject',
                providerId: 'google',
                userId: currentUser.id,
                accessToken: 'synthetic-private-access-token',
                accessTokenExpiresAt: now,
                createdAt: now,
                updatedAt: now,
            },
            forceAllowId: true,
        })
        await context.adapter.create({
            model: 'verification',
            data: {
                id: verificationId,
                identifier: 'synthetic-identifier',
                value: 'synthetic-private-value',
                expiresAt: now,
                createdAt: now,
                updatedAt: now,
            },
            forceAllowId: true,
        })

        assert.partialDeepStrictEqual(await database.select().from(account).where(eq(account.id, accountId)).get(), {
            userId: currentUser.id,
            providerId: 'google',
            accessTokenExpiresAt: now,
        })
        assert.partialDeepStrictEqual(
            await database.select().from(verification).where(eq(verification.id, verificationId)).get(),
            {
                identifier: 'synthetic-identifier',
                value: 'synthetic-private-value',
                expiresAt: now,
            },
        )
    })
})

describe('native sign-out and endpoint restrictions', () => {
    it('applies Origin and JSON checks before native sign-out can revoke a session', async () => {
        const { cookie } = await seedSession()

        const deniedOrigin = await request('/v1/auth/sign-out', {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: '{}',
        })
        const deniedMediaType = await request('/v1/auth/sign-out', {
            method: 'POST',
            headers: { cookie, Origin: origin, 'Content-Type': 'text/plain' },
            body: '{}',
        })

        assert.equal(deniedOrigin.status, 403)
        assert.equal(deniedMediaType.status, 415)
        assert.equal((await request('/v1/me', { headers: { cookie } })).status, 200)
    })

    it('revokes the persisted session, clears cookies, and persists native rate limiting', async () => {
        const { cookie } = await seedSession()

        const response = await request('/v1/auth/sign-out', {
            method: 'POST',
            headers: { cookie, Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.20' },
            body: '{}',
        })

        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { success: true })
        assert.equal(
            response.headers.getSetCookie().some(value => /session_token=.*Max-Age=0/.test(value)),
            true,
        )
        assert.equal((await request('/v1/me', { headers: { cookie } })).status, 401)
        assert.ok((await database.select().from(rateLimit)).length > 0)
    })

    it('does not report successful logout when the database rejects revocation', async () => {
        const { cookie } = await seedSession()
        await platform.env.DB.prepare(
            "CREATE TRIGGER reject_session_deletion BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END",
        ).run()

        const response = await request('/v1/auth/sign-out', {
            method: 'POST',
            headers: { cookie, Origin: origin, 'Content-Type': 'application/json' },
            body: '{}',
        })

        assert.equal(response.status, 503)
        assert.deepEqual(await response.json(), { code: 'sign_out_failed' })
        assert.equal((await request('/v1/me', { headers: { cookie } })).status, 200)
    })

    for (const path of [
        '/v1/auth/get-session',
        '/v1/auth/get-session/',
        '/v1/auth/%67et-session',
        '/v1/auth/get-session?disableCookieCache=true',
        '/v1/auth/list-sessions',
        '/v1/auth/get-token',
        '/v1/auth/get-access-token',
        '/v1/auth/callback/synthetic-provider',
        '/v1/auth/reset-password/synthetic-token',
        '/v1/auth/update-user',
        '/v1/auth/list-accounts',
        '/v1/auth/sign-in/email',
        '/v1/auth/sign-out/',
        '/v1/auth/%73ign-out',
        '/v1/auth/sign-out?callbackURL=%2Fapp',
    ]) {
        it(`keeps native token and alternate endpoints unavailable: ${path}`, async () => {
            const { cookie } = await seedSession()

            for (const method of ['GET', 'POST']) {
                const response = await request(path, {
                    method,
                    headers: { cookie, Origin: origin, 'Content-Type': 'application/json' },
                    ...(method === 'POST' ? { body: '{}' } : {}),
                })

                assert.equal(response.status, 404)
                assert.ok(!(await response.text()).includes(decodeURIComponent(cookie)))
            }

            assert.equal((await request('/v1/me', { headers: { cookie } })).status, 200)
        })
    }

    for (const body of ['', 'null', '[]', '{"callbackURL":"/app"}', '{']) {
        it(`requires an empty JSON object for sign-out: ${body}`, async () => {
            const { cookie } = await seedSession()

            const response = await request('/v1/auth/sign-out', {
                method: 'POST',
                headers: { cookie, Origin: origin, 'Content-Type': 'application/json' },
                body,
            })

            assert.equal(response.status, 400)
            assert.equal((await request('/v1/me', { headers: { cookie } })).status, 200)
        })
    }
})

describe('application mutation security', () => {
    const protectedApp = new Hono<WorkerEnvironment>()
        .use('*', requireApplicationMutation, requireVerifiedUser)
        .all('/mutation', context => context.json({ userId: context.get('user').id }))

    for (const suppliedOrigin of [undefined, 'null', 'http://attacker.test', `${origin}/`, 'http://localhost:53001']) {
        it(`requires the exact configured Origin: ${suppliedOrigin}`, async () => {
            const { cookie } = await seedSession()
            const headers = new Headers({ cookie, 'Content-Type': 'application/json' })

            if (suppliedOrigin !== undefined) headers.set('Origin', suppliedOrigin)

            const response = await protectedApp.request(
                '/mutation',
                { method: 'POST', headers, body: '{}' },
                environment(),
            )

            assert.equal(response.status, 403)
            assert.deepEqual(await response.json(), { code: 'origin_not_allowed' })
        })
    }

    for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) {
        it(`requires JSON for mutations: ${contentType}`, async () => {
            const { cookie } = await seedSession()
            const headers = new Headers({ cookie, Origin: origin })

            if (contentType !== undefined) headers.set('Content-Type', contentType)

            const response = await protectedApp.request(
                '/mutation',
                { method: 'POST', headers, body: '{}' },
                environment(),
            )

            assert.equal(response.status, 415)
            assert.deepEqual(await response.json(), { code: 'json_required' })
        })
    }

    it('authorizes a verified user with the exact Origin and JSON media type parameters', async () => {
        const { currentUser, cookie } = await seedSession()

        const response = await protectedApp.request(
            '/mutation',
            {
                method: 'POST',
                headers: { cookie, Origin: origin, 'Content-Type': 'application/json; charset=utf-8' },
                body: '{}',
            },
            environment(),
        )

        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { userId: currentUser.id })
    })

    it('preserves renewed cookies when the protected handler fails after authentication', async () => {
        const { cookie } = await seedSession({ age: day + 1000 })
        const failingApp = new Hono<WorkerEnvironment>()
            .use('*', requireApplicationMutation, requireVerifiedUser)
            .post('/mutation', () => {
                throw new Error('synthetic downstream failure')
            })
            .onError((_error, context) => context.json({ code: 'request_failed' }, 500))

        const response = await failingApp.request(
            '/mutation',
            {
                method: 'POST',
                headers: { cookie, Origin: origin, 'Content-Type': 'application/json' },
                body: '{}',
            },
            environment(),
        )

        assert.equal(response.status, 500)
        assert.deepEqual(await response.json(), { code: 'request_failed' })
        assert.ok(response.headers.getSetCookie().some(value => /session_token=.*Max-Age=604800/.test(value)))
    })

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        it(`checks Origin and JSON for ${method} mutations`, async () => {
            const { cookie } = await seedSession()

            const deniedOrigin = await protectedApp.request(
                '/mutation',
                { method, headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' },
                environment(),
            )
            const deniedMediaType = await protectedApp.request(
                '/mutation',
                { method, headers: { cookie, Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' },
                environment(),
            )

            assert.equal(deniedOrigin.status, 403)
            assert.equal(deniedMediaType.status, 415)
        })
    }

    it('rejects expired and unverified sessions before executing a protected mutation', async () => {
        const expired = await seedSession({ expiresAt: new Date(Date.now() - 1000) })
        const unverified = await seedSession({ verified: false })

        for (const [cookie, status] of [
            [expired.cookie, 401],
            [unverified.cookie, 403],
        ] as const) {
            const response = await protectedApp.request(
                '/mutation',
                {
                    method: 'POST',
                    headers: { cookie, Origin: origin, 'Content-Type': 'application/json' },
                    body: '{}',
                },
                environment(),
            )

            assert.equal(response.status, status)
            assert.ok(!(await response.text()).includes('userId'))
        }
    })
})
