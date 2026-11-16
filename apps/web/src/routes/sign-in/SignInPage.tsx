import { useEffect, useRef, useState, type SubmitEvent } from 'react'
import { useLocation } from 'react-router'
import { ApiError } from '../../api/api-error'
import { ApplicationFrame } from '../../app/ApplicationFrame'
import { signInCopy } from '../../content/auth-shell'
import { safeDestination } from '../../features/auth/destination'
import { requestGoogleSignIn } from '../../features/auth/google-sign-in'
import { requestMagicLink } from '../../features/auth/magic-link'
import { useAuth } from '../../features/auth/use-auth'
import { Stack } from '../../shared/Stack'
import { StateMessage } from '../../shared/StateMessage'
import { SupportingText } from '../../shared/SupportingText'
import { useBrowserAvailability } from '../../shared/use-browser-availability'
import { useRetryTime } from '../../shared/use-retry-time'
import action from '../../shared/Action.module.css'
import form from '../../shared/Form.module.css'
import styles from './SignInPage.module.css'

export function SignInPage() {
    const { api } = useAuth()
    const location = useLocation()
    const parameters = new URLSearchParams(location.search)
    const destination = safeDestination(parameters.get('destination'))
    const [email, setEmail] = useState('')
    const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null)
    const [pendingMethod, setPendingMethod] = useState<'magic-link' | 'google' | null>(null)
    const [invalidEmail, setInvalidEmail] = useState(false)
    const [feedback, setFeedback] = useState<string | null>(() => {
        if (parameters.get('error') === 'google-sign-in') {
            return signInCopy.googleError
        }

        return parameters.has('error') ? signInCopy.invalidLink : null
    })
    const [retryAt, setRetryAt] = useState<number>()
    const request = useRef<AbortController | null>(null)
    const mounted = useRef(true)
    const emailInput = useRef<HTMLInputElement>(null)
    const confirmation = useRef<HTMLDivElement>(null)
    const { online } = useBrowserAvailability()
    const rateLimited = useRetryTime(retryAt)
    const pending = pendingMethod !== null
    const disabled = pending || rateLimited || !online

    useEffect(() => {
        mounted.current = true

        return () => {
            mounted.current = false
            request.current?.abort()
        }
    }, [])

    useEffect(() => {
        if (confirmationEmail) {
            confirmation.current?.focus()
        } else {
            emailInput.current?.focus()
        }
    }, [confirmationEmail])

    async function sendLink(address: string): Promise<void> {
        if (request.current || rateLimited || !online) return

        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), 20_000)
        request.current = controller
        setPendingMethod('magic-link')
        setFeedback(null)

        try {
            await requestMagicLink(api, address, destination, controller.signal)

            if (controller.signal.aborted) return

            setConfirmationEmail(address)
            setFeedback(confirmationEmail ? signInCopy.resent : null)
        } catch (error: unknown) {
            if (!mounted.current) return

            // Errors contain only public metadata; raw provider responses never become page content.
            if (error instanceof ApiError && error.status === 429) {
                setRetryAt(error.retryAt ?? Date.now() + 60_000)
                setFeedback(signInCopy.rateLimited)
            } else if (error instanceof ApiError && error.status === 503) {
                setFeedback(signInCopy.deliveryError)
            } else {
                setFeedback(signInCopy.requestError)
            }
        } finally {
            window.clearTimeout(timeout)
            request.current = null

            if (mounted.current) {
                setPendingMethod(null)
            }
        }
    }

    async function signInWithGoogle(): Promise<void> {
        if (request.current || rateLimited || !online) return

        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), 20_000)
        request.current = controller
        setPendingMethod('google')
        setFeedback(null)

        try {
            const url = await requestGoogleSignIn(api, destination, controller.signal)

            if (controller.signal.aborted || !mounted.current) return

            window.location.assign(url)
        } catch (error: unknown) {
            if (!mounted.current) return

            if (error instanceof ApiError && error.status === 429) {
                setRetryAt(error.retryAt ?? Date.now() + 60_000)
                setFeedback(signInCopy.rateLimited)
            } else {
                setFeedback(signInCopy.googleError)
            }
        } finally {
            window.clearTimeout(timeout)
            request.current = null

            if (mounted.current) {
                setPendingMethod(null)
            }
        }
    }

    function submit(event: SubmitEvent<HTMLFormElement>): void {
        event.preventDefault()

        if (disabled) return

        const address = email.trim().toLowerCase()
        const field = emailInput.current

        if (!address || !field?.validity.valid || address.length > 254) {
            setInvalidEmail(true)
            field?.focus()
            return
        }

        setInvalidEmail(false)
        void sendLink(address)
    }

    return (
        <ApplicationFrame>
            <StateMessage
                title={confirmationEmail ? signInCopy.checkTitle : signInCopy.title}
                description={confirmationEmail ? signInCopy.checkDescription : signInCopy.description}
                pending={pending}
            >
                <div className={styles.content}>
                    <Stack>
                        {!online ? <SupportingText role="status">{signInCopy.offline}</SupportingText> : null}
                        <div className={form.actions}>
                            <button
                                className={`${action.action} ${action.secondary} ${styles.google}`}
                                type="button"
                                disabled={disabled}
                                onClick={() => void signInWithGoogle()}
                            >
                                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
                                    <path
                                        fill="#4285f4"
                                        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"
                                    />
                                    <path
                                        fill="#34a853"
                                        d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.97-3.38.97-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"
                                    />
                                    <path
                                        fill="#fbbc05"
                                        d="M6.41 13.93A6 6 0 0 1 6.1 12c0-.67.11-1.32.31-1.93V7.48H3.07A10 10 0 0 0 2 12c0 1.61.38 3.14 1.07 4.52l3.34-2.59Z"
                                    />
                                    <path
                                        fill="#ea4335"
                                        d="M12 5.95c1.47 0 2.79.51 3.82 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.48l3.34 2.59C7.2 7.71 9.4 5.95 12 5.95Z"
                                    />
                                </svg>
                                {signInCopy.google}
                            </button>
                        </div>
                        {confirmationEmail ? (
                            <Stack>
                                <div ref={confirmation} tabIndex={-1}>
                                    <Stack gap="control">
                                        <p className={styles.address}>{confirmationEmail}</p>
                                        <SupportingText>{signInCopy.checkHelp}</SupportingText>
                                    </Stack>
                                </div>
                                <div className={form.actions}>
                                    <button
                                        className={action.action}
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => void sendLink(confirmationEmail)}
                                    >
                                        {signInCopy.resend}
                                    </button>
                                    <button
                                        className={`${action.action} ${action.secondary}`}
                                        type="button"
                                        disabled={pending}
                                        onClick={() => {
                                            setConfirmationEmail(null)
                                            setFeedback(null)
                                        }}
                                    >
                                        {signInCopy.changeEmail}
                                    </button>
                                </div>
                            </Stack>
                        ) : (
                            <form noValidate onSubmit={submit} aria-busy={pending}>
                                <Stack>
                                    <div className={form.field}>
                                        <label className={form.label} htmlFor="sign-in-email">
                                            {signInCopy.email}
                                        </label>
                                        <input
                                            ref={emailInput}
                                            className={form.control}
                                            id="sign-in-email"
                                            name="email"
                                            type="email"
                                            autoComplete="email"
                                            autoCapitalize="none"
                                            spellCheck={false}
                                            required
                                            maxLength={254}
                                            value={email}
                                            disabled={pending}
                                            aria-invalid={invalidEmail}
                                            aria-describedby={invalidEmail ? 'email-help email-error' : 'email-help'}
                                            onChange={event => {
                                                setEmail(event.target.value)
                                                setInvalidEmail(false)
                                            }}
                                        />
                                        <SupportingText id="email-help">{signInCopy.help}</SupportingText>
                                        {invalidEmail ? (
                                            <p id="email-error" className={form.error} role="alert">
                                                {signInCopy.invalidEmail}
                                            </p>
                                        ) : null}
                                    </div>
                                    <div className={form.actions}>
                                        <button className={action.action} type="submit" disabled={disabled}>
                                            {signInCopy.submit}
                                        </button>
                                    </div>
                                </Stack>
                            </form>
                        )}
                        <div aria-live="polite">
                            {pending ? (
                                <SupportingText>
                                    {pendingMethod === 'google' ? signInCopy.googlePending : signInCopy.pending}
                                </SupportingText>
                            ) : null}
                            {feedback ? <SupportingText role="status">{feedback}</SupportingText> : null}
                        </div>
                    </Stack>
                </div>
            </StateMessage>
        </ApplicationFrame>
    )
}
