import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { BetterAuthOptions } from 'better-auth'
import { symmetricDecrypt } from 'better-auth/crypto'
import { sql } from 'drizzle-orm'
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import app from './app'
import { betterAuthOptions } from './auth-options'
import type { WorkerEnvironment } from './environment'
import { createDatabase, type Database } from '@/database/connection'

const origin = 'http://localhost:53000'
const secret = 'test-only-better-auth-secret-at-least-thirty-two-characters'
const clientId = 'synthetic-google-client-id'
const clientSecret = 'synthetic-google-client-secret'
const startPath = '/v1/auth/sign-in/social'
const callbackPath = '/v1/auth/callback/google'

type GoogleIdentity = { sub: string; email: string; email_verified?: boolean | string }
type TokenOptions = { audience?: string; issuer?: string; expiration?: number | string; key?: KeyLike }
type Flow = { authorization: URL; cookie: string }
type IssuedCode = { challenge: string; idToken: string; accessToken: string; refreshToken: string }
type UserRow = { id: string; email: string; emailVerified: number }
type AccountRow = { userId: string; accountId: string; accessToken: string; refreshToken: string; idToken: string }

let platform: PlatformProxy<Pick<Env, 'DB' | 'AUTH_EMAIL' | 'AUTH_MAIL_FROM'>>
let database: Database
let signingKey: KeyLike
let publicKey: JWK
let codes = new Map<string, IssuedCode>()
let exchanges: string[] = []
let messages: EmailMessageBuilder[] = []
let submissions = 0
let tokenEndpointFails = false

const captureEmail: Env['AUTH_EMAIL'] = {
    send(message) {
        assert.ok('text' in message)
        messages.push(message)

        return Promise.resolve({ messageId: randomUUID() })
    },
}

function environment(): WorkerEnvironment['Bindings'] {
    return {
        ...platform.env,
        AUTH_EMAIL: captureEmail,
        APP_BASE_URL: origin,
        BETTER_AUTH_SECRET: secret,
        GOOGLE_CLIENT_ID: clientId,
        GOOGLE_CLIENT_SECRET: clientSecret,
    }
}

async function request(path: string | URL, options: RequestInit = {}): Promise<Response> {
    return app.request(new Request(new URL(path, origin), options), undefined, environment())
}

function submit(body: unknown, path = startPath): Promise<Response> {
    submissions += 1

    return request(path, {
        method: 'POST',
        headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            'CF-Connecting-IP': `192.0.2.${submissions}`,
        },
        body: JSON.stringify(body),
    })
}

function cookies(response: Response): string {
    return response.headers
        .getSetCookie()
        .map(value => value.split(';', 1)[0])
        .join('; ')
}

function hasSession(response: Response): boolean {
    return response.headers.getSetCookie().some(value => /session_token=[^;]/.test(value))
}

function sessionCookie(response: Response): string {
    const cookie = response.headers.getSetCookie().find(value => /session_token=[^;]/.test(value))

    assert.ok(cookie, 'A successful callback must issue a browser session.')
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Path=\//)

    return cookie.split(';', 1)[0]
}

function users(): Promise<UserRow[]> {
    return database.all<UserRow>(sql`select id, email, email_verified as emailVerified from users`)
}

function accounts(): Promise<AccountRow[]> {
    return database.all<AccountRow>(sql`
        select user_id as userId, account_id as accountId,
               access_token as accessToken, refresh_token as refreshToken, id_token as idToken
        from accounts
    `)
}

async function assertRejected(response: Response): Promise<void> {
    assert.equal(response.status, 302)
    assert.equal(hasSession(response), false)

    const destination = new URL(response.headers.get('location') ?? '', origin)

    assert.equal(destination.origin, origin)
    assert.equal(destination.pathname, '/sign-in')
    assert.ok(destination.searchParams.get('error'))
    assert.equal(await response.text(), '')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

async function begin(body: Record<string, unknown> = {}): Promise<Flow> {
    const response = await submit({
        provider: 'google',
        callbackURL: '/app',
        errorCallbackURL: '/sign-in?error=google-sign-in',
        ...body,
    })

    assert.equal(response.status, 200)

    const payload: { url: string; redirect: boolean } = await response.json()
    const authorization = new URL(payload.url)

    assert.equal(authorization.origin, 'https://accounts.google.com')
    assert.equal(authorization.pathname, '/o/oauth2/v2/auth')
    assert.equal(authorization.searchParams.get('client_id'), clientId)
    assert.equal(authorization.searchParams.get('redirect_uri'), `${origin}${callbackPath}`)
    assert.equal(authorization.searchParams.get('response_type'), 'code')
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(authorization.searchParams.get('code_challenge'))
    assert.ok(authorization.searchParams.get('state'))
    assert.ok(
        response.headers.getSetCookie().every(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax')),
    )
    assert.equal(payload.redirect, true)

    return { authorization, cookie: cookies(response) }
}

async function callback(
    flow: Flow,
    identity: GoogleIdentity,
    query: Record<string, string> = {},
    tokenOptions: TokenOptions = {},
): Promise<Response> {
    const code = randomUUID()
    const idToken = await new SignJWT({ name: 'Google Person', ...identity })
        .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-google-key' })
        .setIssuer(tokenOptions.issuer ?? 'https://accounts.google.com')
        .setAudience(tokenOptions.audience ?? clientId)
        .setIssuedAt()
        .setExpirationTime(tokenOptions.expiration ?? '5m')
        .sign(tokenOptions.key ?? signingKey)

    codes.set(code, {
        challenge: flow.authorization.searchParams.get('code_challenge') ?? '',
        idToken,
        accessToken: `synthetic-access-${code}`,
        refreshToken: `synthetic-refresh-${code}`,
    })

    const url = new URL(callbackPath, origin)
    url.searchParams.set('state', flow.authorization.searchParams.get('state') ?? '')
    url.searchParams.set('code', code)

    for (const [field, value] of Object.entries(query)) {
        url.searchParams.set(field, value)
    }

    return request(url, { headers: { Cookie: flow.cookie, Accept: 'text/html' } })
}

async function magicLink(email: string): Promise<URL> {
    const response = await submit({ email, callbackURL: '/app' }, '/v1/auth/sign-in/magic-link')

    assert.equal(response.status, 200)

    const text = messages.at(-1)?.text
    const link = text?.split('\n').find(line => line.startsWith(`${origin}/v1/auth/magic-link/verify?`))

    assert.ok(link)

    return new URL(link)
}

async function principal(response: Response): Promise<string> {
    const me = await request('/v1/me', { headers: { Cookie: sessionCookie(response) } })
    const payload: { user: { id: string; emailVerified: boolean } } = await me.json()

    assert.equal(me.status, 200)
    assert.equal(payload.user.emailVerified, true)

    return payload.user.id
}

async function simulatedGoogle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const outbound = new Request(input, init)

    if (outbound.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return Response.json({ keys: [publicKey] })
    }

    assert.equal(outbound.url, 'https://oauth2.googleapis.com/token', 'Unexpected outbound authentication request.')
    assert.equal(outbound.method, 'POST')

    const body = new URLSearchParams(await outbound.text())
    const code = body.get('code') ?? ''
    const issued = codes.get(code)

    assert.ok(issued, 'The token endpoint must receive an authorization code issued for this test browser.')
    assert.equal(body.get('grant_type'), 'authorization_code')
    assert.equal(body.get('client_id'), clientId)
    assert.equal(body.get('client_secret'), clientSecret)
    assert.equal(body.get('redirect_uri'), `${origin}${callbackPath}`)
    assert.equal(
        createHash('sha256')
            .update(body.get('code_verifier') ?? '')
            .digest('base64url'),
        issued.challenge,
    )

    exchanges.push(code)

    if (tokenEndpointFails) {
        return Response.json(
            { error: 'invalid_grant', error_description: 'synthetic-private-provider-error' },
            { status: 400 },
        )
    }

    return Response.json({
        token_type: 'Bearer',
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        id_token: issued.idToken,
        expires_in: 3600,
        scope: 'openid email profile',
    })
}

beforeAll(async () => {
    const pair = await generateKeyPair('RS256')
    signingKey = pair.privateKey
    publicKey = { ...(await exportJWK(pair.publicKey)), kid: 'synthetic-google-key', alg: 'RS256', use: 'sig' }

    platform = await getPlatformProxy<Pick<Env, 'DB' | 'AUTH_EMAIL' | 'AUTH_MAIL_FROM'>>({
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
    codes = new Map()
    exchanges = []
    messages = []
    submissions = 0
    tokenEndpointFails = false

    await database.run(sql`delete from sessions`)
    await database.run(sql`delete from accounts`)
    await database.run(sql`delete from users`)
    await database.run(sql`delete from verifications`)
    await database.run(sql`delete from auth_rate_limits`)

    vi.stubGlobal('fetch', simulatedGoogle)
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('Google redirect OAuth through simulated provider transport', () => {
    it('creates one verified user, preserves PKCE and browser cookies, and encrypts all stored OAuth tokens', async () => {
        const flow = await begin({ callbackURL: '/app/billing?view=credits' })

        assert.deepEqual(await users(), [])

        const response = await callback(flow, {
            sub: 'google-person',
            email: 'person@example.test',
            email_verified: true,
        })

        assert.equal(response.status, 302)
        assert.equal(new URL(response.headers.get('location') ?? '', origin).href, `${origin}/app/billing?view=credits`)
        assert.equal(await response.text(), '')
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer')

        const canonicalId = await principal(response)
        const storedUsers = await users()
        const storedAccounts = await accounts()
        const issued = codes.get(exchanges[0])

        assert.ok(issued)
        assert.deepEqual(storedUsers, [{ id: canonicalId, email: 'person@example.test', emailVerified: 1 }])
        assert.equal(storedAccounts.length, 1)
        assert.equal(storedAccounts[0].userId, canonicalId)
        assert.equal(storedAccounts[0].accountId, 'google-person')

        for (const field of ['accessToken', 'refreshToken', 'idToken'] as const) {
            assert.notEqual(storedAccounts[0][field], issued[field])
            assert.equal(await symmetricDecrypt({ key: secret, data: storedAccounts[0][field] }), issued[field])
        }

        const repeated = await callback(await begin(), {
            sub: 'google-person',
            email: 'person@example.test',
            email_verified: true,
        })

        assert.equal(await principal(repeated), canonicalId)
        assert.notEqual(sessionCookie(repeated), sessionCookie(response))
        assert.equal((await users()).length, 1)
        assert.equal((await accounts()).length, 1)

        const updated = (await accounts())[0]
        const refreshedTokens = codes.get(exchanges[1])

        assert.ok(refreshedTokens)

        for (const field of ['accessToken', 'refreshToken', 'idToken'] as const) {
            assert.notEqual(updated[field], refreshedTokens[field])
            assert.equal(await symmetricDecrypt({ key: secret, data: updated[field] }), refreshedTokens[field])
        }
    })

    it('rejects a failed Google token exchange without persisting identities or leaking provider errors', async () => {
        const flow = await begin()
        tokenEndpointFails = true
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        const response = await callback(flow, {
            sub: 'failed-exchange',
            email: 'failed@example.test',
            email_verified: true,
        })

        await assertRejected(response)
        assert.deepEqual(await users(), [])
        assert.deepEqual(await accounts(), [])
        assert.deepEqual(await database.all(sql`select id from sessions`), [])
        assert.ok(!JSON.stringify(errorLog.mock.calls).includes('synthetic-private-provider-error'))
        assert.ok(!response.headers.get('location')?.includes('synthetic-private-provider-error'))
    })

    it('rejects Google tokens with invalid signatures, audience, issuer, or expiry before persisting an identity', async () => {
        const wrongSigner = await generateKeyPair('RS256')
        const invalidTokens: TokenOptions[] = [
            { key: wrongSigner.privateKey },
            { audience: 'another-google-client' },
            { issuer: 'https://attacker.example' },
            { expiration: Math.floor(Date.now() / 1000) - 3600 },
        ]

        for (const tokenOptions of invalidTokens) {
            const response = await callback(
                await begin(),
                { sub: 'invalid-token', email: 'invalid-token@example.test', email_verified: true },
                {},
                tokenOptions,
            )

            await assertRejected(response)
            assert.deepEqual(await users(), [])
            assert.deepEqual(await accounts(), [])
            assert.deepEqual(await database.all(sql`select id from sessions`), [])
        }
    })

    it('handles cancellation without a provider exchange, account creation, or session', async () => {
        const flow = await begin()
        const cancelled = new URL(callbackPath, origin)
        cancelled.searchParams.set('state', flow.authorization.searchParams.get('state') ?? '')
        cancelled.searchParams.set('error', 'access_denied')
        cancelled.searchParams.set('error_description', 'Synthetic cancellation text that must not be exposed')

        const response = await request(cancelled, { headers: { Cookie: flow.cookie } })

        await assertRejected(response)
        assert.ok(!response.headers.get('location')?.includes('Synthetic'))
        assert.deepEqual(exchanges, [])
        assert.deepEqual(await users(), [])
        assert.deepEqual(await accounts(), [])
    })

    it('rejects missing, invalid, cross-browser, expired, and replayed state before another token exchange', async () => {
        const identity = { sub: 'state-person', email: 'state@example.test', email_verified: true }
        const first = await begin()
        const other = await begin()

        await assertRejected(await callback(first, identity, { state: '' }))
        await assertRejected(await callback(first, identity, { state: 'invalid-state' }))
        await assertRejected(await callback({ ...first, cookie: '' }, identity))
        await assertRejected(await callback({ ...first, cookie: other.cookie }, identity))
        assert.deepEqual(exchanges, [])

        const success = await callback(first, identity)

        assert.equal(await principal(success), (await users())[0].id)
        await assertRejected(await callback(first, identity))
        assert.equal(exchanges.length, 1)

        const expired = await begin()
        const stored = await database.all<{ id: string; value: string }>(sql`select id, value from verifications`)

        for (const record of stored) {
            const value: unknown = JSON.parse(record.value)

            assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))

            const expiredValue = { ...value, expiresAt: Date.now() - 1 }

            await database.run(
                sql`update verifications set value = ${JSON.stringify(expiredValue)} where id = ${record.id}`,
            )
        }

        await assertRejected(await callback(expired, identity))
        assert.equal(exchanges.length, 1)
        assert.equal((await users()).length, 1)
    })

    for (const claim of [false, 'false', undefined]) {
        it(`rejects an unverified Google email before account creation or linking: ${claim}`, async () => {
            const email = 'unverified@example.test'
            const identity = { sub: 'unverified-google', email, email_verified: claim }

            await assertRejected(await callback(await begin(), identity))
            assert.deepEqual(await users(), [])
            assert.deepEqual(await accounts(), [])

            const verifiedLocal = await request(await magicLink(email))
            const canonicalId = await principal(verifiedLocal)

            await assertRejected(await callback(await begin(), identity))
            assert.deepEqual(await accounts(), [])
            assert.deepEqual(await users(), [{ id: canonicalId, email, emailVerified: 1 }])
        })
    }

    it('rejects newly unverified provider identity even when its Google account is already linked', async () => {
        const identity = { sub: 'linked-google', email: 'linked@example.test', email_verified: true }
        const first = await callback(await begin(), identity)
        const canonicalId = await principal(first)
        const originalAccounts = await accounts()

        await assertRejected(await callback(await begin(), { ...identity, email_verified: false }))
        assert.deepEqual(await accounts(), originalAccounts)
        assert.equal((await users())[0].id, canonicalId)
    })

    it('refuses implicit linking to an unverified local email', async () => {
        const now = Date.now()
        const id = randomUUID()

        await database.run(sql`
            insert into users (id, name, email, email_verified, created_at, updated_at)
            values (${id}, 'Local Person', 'local-unverified@example.test', 0, ${now}, ${now})
        `)

        await assertRejected(
            await callback(await begin(), {
                sub: 'local-unverified-google',
                email: 'local-unverified@example.test',
                email_verified: true,
            }),
        )
        assert.deepEqual(await users(), [{ id, email: 'local-unverified@example.test', emailVerified: 0 }])
        assert.deepEqual(await accounts(), [])
    })

    for (const firstMethod of ['magic-link', 'google']) {
        it(`uses one canonical user when ${firstMethod} signs up first`, async () => {
            const email = 'both-methods@example.test'
            const google = async (): Promise<Response> =>
                callback(await begin(), { sub: 'both-methods-google', email, email_verified: true })
            const magic = async (): Promise<Response> => request(await magicLink(email))
            const first = await (firstMethod === 'google' ? google() : magic())
            const canonicalId = await principal(first)
            const second = await (firstMethod === 'google' ? magic() : google())

            assert.equal(await principal(second), canonicalId)
            assert.equal((await users()).length, 1)
            assert.deepEqual(
                (await accounts()).map(row => row.userId),
                [canonicalId],
            )
        })
    }

    it('keeps a single canonical user during concurrent Google and magic-link signup and permits safe recovery', async () => {
        const email = 'concurrent@example.test'
        const identity = { sub: 'concurrent-google', email, email_verified: true }
        const flows = await Promise.all([begin(), begin()])
        const link = await magicLink(email)
        const userOptions: NonNullable<BetterAuthOptions['user']> = betterAuthOptions.user
        const validateUserInfo = userOptions.validateUserInfo

        assert.ok(validateUserInfo)

        let arrivals = 0
        let release = (): void => undefined
        const allReady = new Promise<void>(resolveReady => {
            release = resolveReady
        })

        // All three requests observe no user before any is allowed to insert one.
        const validation = vi.spyOn(userOptions, 'validateUserInfo').mockImplementation(async (input, context) => {
            const result = await validateUserInfo(input, context)

            if (input.source.action === 'create-user' && input.user.email === email) {
                arrivals += 1

                if (arrivals === 3) {
                    release()
                }

                await allReady
            }

            return result
        })

        const responses = await Promise.all([callback(flows[0], identity), callback(flows[1], identity), request(link)])
        validation.mockRestore()

        const successful = responses.filter(hasSession)
        const storedUsers = await users()

        assert.equal(arrivals, 3)
        assert.equal(successful.length, responses.length)
        assert.equal(storedUsers.length, 1)

        for (const response of successful) {
            assert.equal(await principal(response), storedUsers[0].id)
        }

        const retryGoogle = await callback(await begin(), identity)
        const retryMagic = await request(await magicLink(email))

        assert.equal(await principal(retryGoogle), storedUsers[0].id)
        assert.equal(await principal(retryMagic), storedUsers[0].id)
        assert.equal((await users()).length, 1)
        assert.deepEqual(
            (await accounts()).map(row => row.userId),
            [storedUsers[0].id],
        )
    })

    it('rejects unsafe callbacks, direct ID tokens, and alternate linking/provider inputs before creating state', async () => {
        const unsafeDestinations = [
            'https://attacker.example/app',
            '//attacker.example/app',
            '/\\attacker.example/app',
            'javascript:alert(1)',
            `${origin.replace('://', '://name:password@')}/app`,
        ]

        for (const field of ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL']) {
            for (const destination of unsafeDestinations) {
                const response = await submit({ provider: 'google', [field]: destination })

                assert.equal(response.status, 400)
                assert.equal(hasSession(response), false)
                assert.deepEqual(response.headers.getSetCookie(), [])
            }
        }

        for (const input of [
            { provider: 'google', idToken: { token: 'synthetic-direct-id-token' } },
            { provider: 'github' },
            { provider: 'google', additionalData: { link: { userId: 'other-user', email: 'other@example.test' } } },
            { provider: 'google', disableRedirect: true },
        ]) {
            const response = await submit(input)

            assert.equal(response.status, 400)
            assert.deepEqual(response.headers.getSetCookie(), [])
        }

        const linkResponse = await submit({ provider: 'google', callbackURL: '/app' }, '/v1/auth/link-social')

        assert.equal(linkResponse.status, 404)
        assert.deepEqual(exchanges, [])
        assert.deepEqual(await users(), [])
        assert.deepEqual(await database.all(sql`select id from verifications`), [])
    })
})
