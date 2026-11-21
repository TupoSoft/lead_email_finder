import type { ErrorHandler } from 'hono'
import type { WorkerEnvironment } from '@/environment'
import { DatabaseOperationError } from '@/database/database-operation-error.ts'

export const errorHandler: ErrorHandler<WorkerEnvironment> = (error, context) => {
    const databaseError = error instanceof DatabaseOperationError ? error : undefined

    console.error({
        event: 'request_failed',
        requestId: context.get('requestId'),
        dependency: databaseError ? 'd1' : undefined,
        operation: databaseError?.operation,
    })

    return context.json({ status: 'error' }, 500)
}
