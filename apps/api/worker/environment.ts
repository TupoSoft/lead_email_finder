export type VerifiedUser = {
    id: string
    name: string
    email: string
    emailVerified: boolean
    image: string | null
}

export type WorkerEnvironment = {
    // Widen Wrangler's development URL literal to allow the configured application origin.
    Bindings: Omit<Env, 'APP_BASE_URL'> & { APP_BASE_URL: string }
    Variables: { requestId: string; user: VerifiedUser }
}
