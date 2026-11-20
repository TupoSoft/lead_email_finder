import * as authMail from '../src/libs/better-auth/src/mail/auth-mail-delivery'
import { authMailConfigurationSchema, emailAddressSchema, type AuthMailConfiguration } from './environment'

export type { AuthMailConfiguration } from './environment'

export function createAuthMailDelivery(configuration: AuthMailConfiguration): authMail.AuthMailDelivery {
    const { AUTH_MAIL_FROM: from, AUTH_EMAIL: binding } = authMailConfigurationSchema.parse(configuration)

    return {
        async send(message: authMail.AuthMailMessage): Promise<void> {
            if (
                !emailAddressSchema.safeParse(message.to).success ||
                /[\r\n]/.test(message.to) ||
                !message.subject.trim() ||
                /[\r\n]/.test(message.subject) ||
                message.subject.includes('\0') ||
                !message.text.trim()
            ) {
                throw new authMail.AuthMailDeliveryError('invalid-message')
            }

            try {
                await binding.send({
                    from,
                    to: message.to,
                    subject: message.subject,
                    text: message.text,
                })
            } catch (error: unknown) {
                // Provider errors may contain the recipient, link, or raw message. Retain only a bounded reason.
                throw new authMail.AuthMailDeliveryError(deliveryFailureReason(error))
            }
        },
    }
}

function deliveryFailureReason(error: unknown): authMail.AuthMailDeliveryError['reason'] {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined

    switch (code) {
        case 'E_VALIDATION_ERROR':
        case 'E_FIELD_MISSING':
        case 'E_CONTENT_TOO_LARGE':
            return 'invalid-message'

        case 'E_SENDER_NOT_VERIFIED':
        case 'E_SENDER_DOMAIN_NOT_AVAILABLE':
        case 'E_RECIPIENT_NOT_ALLOWED':
        case 'E_RECIPIENT_SUPPRESSED':
        case 'E_ACCOUNT_SUSPENDED':
            return 'rejected'

        default:
            return 'unavailable'
    }
}
