import type { BetterAuthOptions } from 'better-auth'

export const betterAuthOptions = {
    appName: 'Lead Email Finder',
    basePath: '/v1/auth',
    // Review these exact static paths when upgrading Better Auth.
    // Parameterized core routes are disabled by the browser policy hook because patterns are not supported here.
    disabledPaths: [
        '/account-info',
        '/change-email',
        '/change-password',
        '/delete-user',
        '/delete-user/callback',
        '/error',
        '/get-access-token',
        '/get-session',
        '/link-social',
        '/list-accounts',
        '/list-sessions',
        '/ok',
        '/refresh-token',
        '/request-password-reset',
        '/reset-password',
        '/revoke-other-sessions',
        '/revoke-session',
        '/revoke-sessions',
        '/send-verification-email',
        '/sign-in/email',
        '/sign-in/social',
        '/sign-up/email',
        '/unlink-account',
        '/update-session',
        '/update-user',
        '/verify-email',
        '/verify-password',
    ],
    session: {
        expiresIn: 60 * 60 * 24 * 7,
        updateAge: 60 * 60 * 24,
        cookieCache: { enabled: false },
    },
    rateLimit: {
        enabled: true,
        storage: 'database',
        customRules: {
            '/sign-in/magic-link': { window: 60, max: 5 },
            '/magic-link/verify': { window: 60, max: 10 },
        },
    },
    advanced: {
        // Better Auth otherwise skips origin validation in test mode.
        disableOriginCheck: false,
        database: { generateId: 'uuid' },
        ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
        defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
    },
    emailAndPassword: { enabled: false },
    telemetry: { enabled: false },
    // Propagate unexpected errors past the router's raw fallback logger to our sanitized HTTP boundary.
    onAPIError: { throw: true },
    // Driver errors may include SQL and personal data. The HTTP boundary logs a fixed event instead.
    logger: { disabled: true },
} satisfies BetterAuthOptions
