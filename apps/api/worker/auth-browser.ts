import type { AuthContext, BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { sql } from 'drizzle-orm'
import type { Database } from '@/database/connection'

const authPath = '/v1/auth'
const requestPath = `${authPath}/sign-in/magic-link`
const verificationPath = `${authPath}/magic-link/verify`
const signOutPath = `${authPath}/sign-out`

const callbackFields = ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL']
const submissionFields = ['email', ...callbackFields]
const verificationFields = ['token', ...callbackFields]

function hasOnlyFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
        return false
    }

    return Object.keys(value).every(field => fields.includes(field))
}

function redirectDefaults(input: Record<string, unknown>, origin: string): Record<string, unknown> {
    for (const field of callbackFields) {
        const value = input[field]

        if (typeof value !== 'string') {
            continue
        }

        // Better Auth validates URL syntax and origins; we only reject URL credentials here.
        const destination = URL.parse(value, origin)

        if (destination?.username || destination?.password) {
            throw new APIError('BAD_REQUEST', { code: 'invalid_request', message: 'Invalid request.' })
        }
    }

    let callbackURL = input.callbackURL

    if (callbackURL === undefined || callbackURL === '') {
        // A callback prevents native verification from returning JSON credentials.
        callbackURL = '/app'
    }

    // Preserve supplied callbacks so Better Auth can validate them before consuming the token.
    return { ...input, callbackURL }
}

function isSuccessfulVerification(response: Response, sessionCookieName: string): boolean {
    if (response.status < 300 || response.status >= 400) {
        return false
    }

    // Error callbacks can equal success callbacks. Only a session-issuing redirect is a successful verification.
    return response.headers
        .getSetCookie()
        .some(cookie => cookie.startsWith(`${sessionCookieName}=`) && !cookie.startsWith(`${sessionCookieName}=;`))
}

export function browserAuthResponse(response: Response): Response {
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    headers.set('Referrer-Policy', 'no-referrer')

    const retryAfter = headers.get('X-Retry-After')

    if (retryAfter) {
        headers.set('Retry-After', retryAfter)
    }

    return new Response(response.body, { status: response.status, headers })
}

export function browserAuthFailure(url: URL, origin: string): Response {
    if (url.pathname === verificationPath) {
        return new Response(null, { status: 302, headers: { Location: `${origin}/sign-in?error=invalid-link` } })
    }

    if (url.pathname === requestPath) {
        return Response.json({ code: 'magic_link_delivery_failed' }, { status: 503 })
    }

    if (url.pathname === signOutPath) {
        return Response.json({ code: 'sign_out_failed' }, { status: 503 })
    }

    return Response.json({ status: 'error' }, { status: 500 })
}

export function browserAuthPolicy(database: Database, origin: string, requestId?: string): BetterAuthPlugin {
    // Better Auth creates one HTTP AuthContext per request, including when an instance is reused.
    const requests = new WeakMap<AuthContext, URL>()
    const failureURL = `${origin}/sign-in?error=invalid-link`

    return {
        id: 'browser-auth-policy',
        onRequest(request, context) {
            const url = new URL(request.url)
            requests.set(context, url)

            // disabledPaths only matches exact paths; these native routes have dynamic segments.
            if (
                url.pathname.startsWith(`${authPath}/callback/`) ||
                url.pathname.startsWith(`${authPath}/reset-password/`)
            ) {
                return Promise.resolve({ response: new Response('Not Found', { status: 404 }) })
            }

            if ((url.pathname === requestPath || url.pathname === signOutPath) && url.search) {
                return Promise.resolve({ response: new Response('Not Found', { status: 404 }) })
            }

            if (request.method === 'GET' && url.pathname === verificationPath) {
                if (request.headers.get('Accept')?.toLowerCase().includes('application/json')) {
                    return Promise.resolve({ response: Response.json({ code: 'invalid_request' }, { status: 400 }) })
                }
            }

            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
                if (request.headers.get('Origin') !== origin) {
                    return Promise.resolve({ response: Response.json({ code: 'origin_not_allowed' }, { status: 403 }) })
                }

                const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()

                if (contentType !== 'application/json') {
                    return Promise.resolve({ response: Response.json({ code: 'json_required' }, { status: 415 }) })
                }
            }

            return Promise.resolve()
        },
        hooks: {
            before: [
                {
                    matcher: context =>
                        context.path === '/sign-in/magic-link' ||
                        context.path === '/magic-link/verify' ||
                        context.path === '/sign-out',
                    handler: createAuthMiddleware(context => {
                        const requestContext: {
                            body?: Record<string, unknown>
                            query?: Record<string, unknown>
                        } = {}

                        if (context.path === '/sign-in/magic-link') {
                            const body: unknown = context.body

                            if (!hasOnlyFields(body, submissionFields)) {
                                throw new APIError('BAD_REQUEST', {
                                    code: 'invalid_request',
                                    message: 'Invalid request.',
                                })
                            }

                            requestContext.body = redirectDefaults(body, origin)
                        } else if (context.path === '/magic-link/verify') {
                            const query: unknown = context.query

                            if (!hasOnlyFields(query, verificationFields)) {
                                throw new APIError('BAD_REQUEST', {
                                    code: 'invalid_request',
                                    message: 'Invalid request.',
                                })
                            }

                            requestContext.query = redirectDefaults(query, origin)
                        } else if (!hasOnlyFields(context.body, [])) {
                            throw new APIError('BAD_REQUEST', { code: 'invalid_request', message: 'Invalid request.' })
                        }

                        return Promise.resolve({ context: requestContext })
                    }),
                },
            ],
            after: [
                {
                    matcher: context => context.path === '/sign-out',
                    handler: createAuthMiddleware(async context => {
                        try {
                            const token = await context.getSignedCookie(
                                context.context.authCookies.sessionToken.name,
                                context.context.secret,
                            )

                            if (!token) {
                                return
                            }

                            // Native sign-out swallows deletion errors. Verify the original signed cookie was revoked.
                            const remainingSession = await database.get<{ id: string }>(
                                sql`select id from sessions where token = ${token}`,
                            )

                            if (!remainingSession) {
                                return
                            }
                        } catch {
                            // A failed revocation check must also fail closed without exposing driver details.
                        }

                        context.context.responseHeaders?.delete('set-cookie')

                        return Response.json({ code: 'sign_out_failed' }, { status: 503 })
                    }),
                },
            ],
        },
        onResponse(response, context) {
            const url = requests.get(context)

            if (url?.pathname === verificationPath && response.status !== 404 && response.status !== 429) {
                if (response.status === 400 && url.searchParams.get('token')) {
                    return Promise.resolve({ response: Response.json({ code: 'invalid_request' }, { status: 400 }) })
                }

                if (!isSuccessfulVerification(response, context.authCookies.sessionToken.name)) {
                    return Promise.resolve({
                        response: new Response(null, { status: 302, headers: { Location: failureURL } }),
                    })
                }
            }

            if (url?.pathname === requestPath && response.status >= 500) {
                console.error({ event: 'magic_link_request_failed', requestId })

                return Promise.resolve({ response: browserAuthFailure(url, origin) })
            }

            if (url?.pathname === signOutPath && response.status >= 500) {
                console.error({ event: 'sign_out_failed', requestId })

                return Promise.resolve({ response: browserAuthFailure(url, origin) })
            }

            // Preserve the browser contract while native validation owns callback rejection.
            // Origin/media-type failures are returned by onRequest before reaching this hook.
            if (
                (url?.pathname === requestPath || url?.pathname === signOutPath) &&
                (response.status === 400 || response.status === 403)
            ) {
                return Promise.resolve({ response: Response.json({ code: 'invalid_request' }, { status: 400 }) })
            }

            return Promise.resolve()
        },
    }
}
