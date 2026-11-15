import { Hono } from 'hono'
import { createServices } from '../../../bootstrap/container.ts'
import type { WorkerEnvironment } from '../../../auth.ts'

export const healthRoutes = new Hono<WorkerEnvironment>().get('/', async context => {
    context.header('Cache-Control', 'no-store')

    try {
        const { healthRepository } = createServices(context.env)

        await healthRepository.check()
        return context.json({ status: 'ok', d1: 'up' })
    } catch {
        console.error({
            event: 'health_check_failed',
            requestId: context.get('requestId'),
            dependency: 'd1',
        })

        return context.json({ status: 'error', d1: 'down' }, 503)
    }
})
