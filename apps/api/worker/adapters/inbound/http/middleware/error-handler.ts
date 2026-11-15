import type { ErrorHandler } from 'hono'
import type { WorkerEnvironment } from '@/environment'

export const errorHandler: ErrorHandler<WorkerEnvironment> = (_error, context) => {
    console.error({ event: 'request_failed', requestId: context.get('requestId') })
    return context.json({ status: 'error' }, 500)
}
