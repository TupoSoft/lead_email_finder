import { createHash } from '@better-auth/utils/hash'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { magicLink } from 'better-auth/plugins/magic-link'
import { sql } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import type { AuthMailDelivery } from '../src/libs/better-auth/src'
import {
    createMagicLinkMessage,
    MAGIC_LINK_LIFETIME_SECONDS,
} from '../src/libs/better-auth/src/mail/magic-link-message'
import { createAuthMailDelivery } from './auth-mail'
import { browserAuthFailure, browserAuthPolicy, browserAuthResponse } from './auth-browser'
import { betterAuthOptions } from './auth-options'
import { createDatabase, type Database } from './database/connection'
import { account, rateLimit, session, user, verification } from './database/schema'

export interface AuthConfiguration {
    APP_BASE_URL: string
    BETTER_AUTH_SECRET: string
}

export type VerifiedUser = {
    id: string
    name: string
    email: string
    emailVerified: boolean
    image: string | null
}

export type WorkerEnvironment = {
    Bindings: Omit<Env, 'APP_BASE_URL'> & AuthConfiguration
    Variables: { requestId: string; user: VerifiedUser }
}

function parseApplicationBaseUrl(baseUrl: unknown): URL {
    if (typeof baseUrl !== 'string') {
        throw new Error('APP_BASE_URL must be an HTTP(S) origin.')
    }

    try {
        return new URL(baseUrl)
    } catch {
        throw new Error('APP_BASE_URL must be an HTTP(S) origin.')
    }
}

export function applicationOrigin(configuration: AuthConfiguration): string {
    const url = parseApplicationBaseUrl(configuration.APP_BASE_URL)

    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    ) {
        throw new Error('APP_BASE_URL must be an HTTP(S) origin.')
    }

    return url.origin
}

export function validateAuthConfiguration(configuration: AuthConfiguration): AuthConfiguration {
    const origin = applicationOrigin(configuration)
    const secret = configuration.BETTER_AUTH_SECRET

    if (typeof secret !== 'string' || secret.length < 32) {
        throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.')
    }

    return { APP_BASE_URL: origin, BETTER_AUTH_SECRET: secret }
}

export function createAuth(
    database: Database,
    configuration: AuthConfiguration,
    mailDelivery?: AuthMailDelivery,
    requestId?: string,
): ReturnType<typeof betterAuth> {
    const validatedConfiguration = validateAuthConfiguration(configuration)
    const origin = validatedConfiguration.APP_BASE_URL

    const options: BetterAuthOptions = {
        ...betterAuthOptions,
        baseURL: origin,
        secret: validatedConfiguration.BETTER_AUTH_SECRET,
        trustedOrigins: [origin],
        database: drizzleAdapter(database, {
            provider: 'sqlite',
            transaction: false,
            schema: { user, session, account, verification, rateLimit },
        }),
        plugins: [
            browserAuthPolicy(database, origin, requestId),
            magicLink({
                expiresIn: MAGIC_LINK_LIFETIME_SECONDS,
                disableSignUp: false,
                storeToken: 'hashed',
                async sendMagicLink({ email, url, token }) {
                    if (mailDelivery) {
                        try {
                            await mailDelivery.send(createMagicLinkMessage(email, url))
                            return
                        } catch {
                            // Provider failures use the shared cleanup and error response below.
                        }
                    }

                    // A failed delivery may have partially succeeded. Revoke its link before reporting failure.
                    const tokenHash = await createHash('SHA-256', 'base64urlnopad').digest(token)
                    const verificationIdentifier = `magic-link:${tokenHash}`

                    await database.run(sql`delete from verifications where identifier = ${verificationIdentifier}`)

                    throw new APIError('SERVICE_UNAVAILABLE', {
                        code: 'magic_link_delivery_failed',
                        message: 'Could not send a sign-in link. Please try again.',
                    })
                },
            }),
        ],
        advanced: {
            ...betterAuthOptions.advanced,
            useSecureCookies: origin.startsWith('https:'),
        },
    }

    const instance = betterAuth(options)
    const handler = async (request: Request): Promise<Response> => {
        let response: Response

        try {
            response = await instance.handler(request)
        } catch {
            console.error({ event: 'auth_request_failed', requestId })
            response = browserAuthFailure(new URL(request.url), origin)
        }

        // Native rate-limit and disabled-path responses bypass Better Auth's response hooks.
        return browserAuthResponse(response)
    }

    return { ...instance, handler, fetch: handler }
}

export function auth(environment: WorkerEnvironment['Bindings'], requestId?: string): ReturnType<typeof betterAuth> {
    const database = createDatabase(environment.DB)
    const mailDelivery = createAuthMailDelivery(environment)

    return createAuth(database, environment, mailDelivery, requestId)
}

export const requireApplicationMutation: MiddlewareHandler<WorkerEnvironment> = async (context, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(context.req.method)) {
        return next()
    }

    const origin = applicationOrigin(context.env)

    if (context.req.header('Origin') !== origin) {
        return context.json({ code: 'origin_not_allowed' }, 403)
    }

    const contentType = context.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase()

    if (contentType !== 'application/json') {
        return context.json({ code: 'json_required' }, 415)
    }

    return next()
}

export const requireVerifiedUser: MiddlewareHandler<WorkerEnvironment> = async (context, next) => {
    context.header('Cache-Control', 'no-store')

    const auth = createAuth(createDatabase(context.env.DB), context.env)
    const result = await auth.api.getSession({ headers: context.req.raw.headers, returnHeaders: true })

    for (const cookie of result.headers.getSetCookie()) {
        context.header('Set-Cookie', cookie, { append: true })
    }

    if (!result.response) {
        return context.json({ code: 'authentication_required' }, 401)
    }

    if (!result.response.user.emailVerified) {
        return context.json({ code: 'email_verification_required' }, 403)
    }

    const currentUser = result.response.user

    context.set('user', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        emailVerified: currentUser.emailVerified,
        image: currentUser.image ?? null,
    })

    return next()
}
