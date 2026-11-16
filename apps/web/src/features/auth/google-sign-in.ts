import type { ApiClient } from '../../api/client'
import { ApiError } from '../../api/api-error'

export async function requestGoogleSignIn(api: ApiClient, callbackURL: string, signal: AbortSignal): Promise<string> {
    const result = await api.POST('/v1/auth/sign-in/social', {
        body: { provider: 'google', callbackURL, errorCallbackURL: '/sign-in?error=google-sign-in' },
        signal,
    })

    const destination = URL.parse(result.data?.url ?? '')

    if (
        result.data?.redirect !== true ||
        !destination ||
        destination.origin !== 'https://accounts.google.com' ||
        destination.username ||
        destination.password
    ) {
        throw new ApiError(result.response.status, 'request-failed')
    }

    return destination.href
}
