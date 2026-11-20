import { createHash } from '@better-auth/utils/hash'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { symmetricEncrypt } from 'better-auth/crypto'
import { magicLink } from 'better-auth/plugins/magic-link'
import { google, verifyGoogleIdToken } from 'better-auth/social-providers'
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
import { wrapCanonicalIdentityAdapter } from './auth-identity-adapter'
import { createDatabase, type Database } from '@/database/connection'
import { account, rateLimit, session, user, verification } from '@/database/schema'
import {
    authConfigurationSchema,
    environmentSchema,
    type AuthConfiguration,
    type WorkerEnvironment,
} from './environment'
import { D1CreditAccountsRepository } from '@/adapters/outbound/d1-credit-accounts-repository'

export function createAuth(
    database: Database,
    configuration: AuthConfiguration,
    mailDelivery?: AuthMailDelivery,
    requestId?: string,
): ReturnType<typeof betterAuth> {
    const validatedConfiguration = authConfigurationSchema.parse(configuration)
    const allowance = validatedConfiguration.INITIAL_CREDIT_ALLOWANCE
    const creditAccounts = new D1CreditAccountsRepository(database)
    const origin = validatedConfiguration.APP_BASE_URL
    const encryptIdToken = async (data: { idToken?: string | null }): Promise<{ data: { idToken: string } } | void> => {
        if (!data.idToken) {
            return
        }

        // Better Auth's encryptOAuthTokens covers access and refresh tokens only.
        return {
            data: {
                idToken: await symmetricEncrypt({ key: validatedConfiguration.BETTER_AUTH_SECRET, data: data.idToken }),
            },
        }
    }

    const options: BetterAuthOptions = {
        ...betterAuthOptions,
        baseURL: origin,
        secret: validatedConfiguration.BETTER_AUTH_SECRET,
        trustedOrigins: [origin],
        socialProviders: {
            google: {
                clientId: validatedConfiguration.GOOGLE_CLIENT_ID,
                clientSecret: validatedConfiguration.GOOGLE_CLIENT_SECRET,
                disableIdTokenSignIn: true,
                async getUserInfo(tokens) {
                    if (!tokens.idToken) {
                        return null
                    }

                    // The provider's default redirect profile reader only decodes the ID token.
                    const claims = await verifyGoogleIdToken({
                        token: tokens.idToken,
                        audience: validatedConfiguration.GOOGLE_CLIENT_ID,
                    })

                    if (!claims) {
                        return null
                    }

                    return google({ clientId: validatedConfiguration.GOOGLE_CLIENT_ID }).getUserInfo(tokens)
                },
            },
        },
        databaseHooks: {
            session: {
                create: {
                    async before(newSession) {
                        const verifiedUser = await database.get<{ id: string }>(sql`
                            select id from users where id = ${newSession.userId} and email_verified = 1
                        `)

                        if (verifiedUser) {
                            await creditAccounts.provision(verifiedUser.id, allowance)
                        }
                    },
                },
            },
            account: {
                create: { before: encryptIdToken },
                update: { before: encryptIdToken },
            },
        },
        database: wrapCanonicalIdentityAdapter(
            drizzleAdapter(database, {
                provider: 'sqlite',
                transaction: false,
                schema: { user, session, account, verification, rateLimit },
            }),
        ),
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

    const origin = environmentSchema.shape.APP_BASE_URL.parse(context.env.APP_BASE_URL)

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

    // Repair an identity/session committed before an interrupted provisioning attempt.
    const creditAccounts = new D1CreditAccountsRepository(createDatabase(context.env.DB))
    const allowance = environmentSchema.shape.INITIAL_CREDIT_ALLOWANCE.parse(context.env.INITIAL_CREDIT_ALLOWANCE)

    await creditAccounts.provision(currentUser.id, allowance)

    context.set('user', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        emailVerified: currentUser.emailVerified,
        image: currentUser.image ?? null,
    })

    return next()
}
