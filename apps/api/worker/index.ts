import { env } from 'cloudflare:workers'
import { ZodError } from 'zod'
import app from './app'
import { environmentSchema } from './environment'

// Fail before serving requests. Auth handlers still validate current bindings after configuration changes.
try {
    environmentSchema.parse(env)
} catch (error) {
    if (!(error instanceof ZodError)) {
        throw error
    }

    const issues = error.issues.map(issue => ({
        field: issue.path.join('.') || 'env',
        message: issue.message,
    }))
    const details = issues.map(issue => `${issue.field}: ${issue.message}`).join('\n')

    console.error({ event: 'invalid_worker_configuration', issues })

    throw new Error(`Invalid Worker configuration:\n${details}`, { cause: error })
}

export default app satisfies ExportedHandler<Env>
