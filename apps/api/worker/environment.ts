import { z } from 'zod'

const originError = 'APP_BASE_URL must be an HTTP(S) origin.'
const senderError = 'AUTH_MAIL_FROM must be a single email address, optionally with a display name.'
const allowanceError = 'INITIAL_CREDIT_ALLOWANCE must be a nonnegative safe integer.'
const googleError = 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be configured.'
const hostnameSchema = z.hostname()

export const emailAddressSchema = z.email().refine(address => hostnameSchema.safeParse(address.split('@')[1]).success)

export const environmentSchema = z.object({
    APP_BASE_URL: z.string({ error: originError }).transform((value, context) => {
        const url = URL.parse(value)

        if (
            !url ||
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash
        ) {
            context.addIssue({ code: 'custom', message: originError })

            return z.NEVER
        }

        return url.origin
    }),

    BETTER_AUTH_SECRET: z
        .string({ error: 'BETTER_AUTH_SECRET must contain at least 32 characters.' })
        .min(32, { error: 'BETTER_AUTH_SECRET must contain at least 32 characters.' }),

    GOOGLE_CLIENT_ID: z.string({ error: googleError }).refine(value => value.trim().length > 0, { error: googleError }),
    GOOGLE_CLIENT_SECRET: z
        .string({ error: googleError })
        .refine(value => value.trim().length > 0, { error: googleError }),

    INITIAL_CREDIT_ALLOWANCE: z
        .string({
            error: issue =>
                issue.input === undefined ? 'INITIAL_CREDIT_ALLOWANCE must be explicitly configured.' : allowanceError,
        })
        .regex(/^\d+$/, { error: allowanceError })
        .transform(Number)
        .refine(Number.isSafeInteger, { error: allowanceError }),

    AUTH_MAIL_FROM: z.string({ error: senderError }).transform((from, context): string | EmailAddress => {
        const namedAddress = /^([^<>"\r\n]+) <([^<>]+)>$/.exec(from)
        const address = namedAddress?.[2] ?? from

        if (
            /[\r\n\0]/.test(from) ||
            !emailAddressSchema.safeParse(address).success ||
            (namedAddress && !namedAddress[1].trim())
        ) {
            context.addIssue({ code: 'custom', message: senderError })

            return z.NEVER
        }

        if (namedAddress) {
            return { name: namedAddress[1].trim(), email: address }
        }

        return address
    }),

    AUTH_EMAIL: z.custom<Env['AUTH_EMAIL']>(
        value => typeof value === 'object' && value !== null && 'send' in value && typeof value.send === 'function',
        { error: 'AUTH_EMAIL must be an Email Service send binding.' },
    ),
})

export const authConfigurationSchema = environmentSchema.pick({
    APP_BASE_URL: true,
    BETTER_AUTH_SECRET: true,
    GOOGLE_CLIENT_ID: true,
    GOOGLE_CLIENT_SECRET: true,
    INITIAL_CREDIT_ALLOWANCE: true,
})

export const authMailConfigurationSchema = environmentSchema.pick({ AUTH_MAIL_FROM: true, AUTH_EMAIL: true })

export type AuthConfiguration = z.input<typeof authConfigurationSchema>
export type AuthMailConfiguration = z.input<typeof authMailConfigurationSchema>

export type VerifiedUser = {
    id: string
    name: string
    email: string
    emailVerified: boolean
    image: string | null
}

export type WorkerEnvironment = {
    // Widen Wrangler's development URL literal to allow the configured application origin.
    Bindings: Omit<Env, 'APP_BASE_URL'> & z.input<typeof environmentSchema>
    Variables: { requestId: string; user: VerifiedUser }
}
