import { Hono } from 'hono'
import { requireVerifiedUser } from '@/auth'
import { createServices } from '@/bootstrap/container'
import type { WorkerEnvironment } from '@/environment'

export const billingRoutes = new Hono<WorkerEnvironment>().get('/summary', requireVerifiedUser, async context => {
    const { creditAccounts } = createServices(context.env)
    const summary = await creditAccounts.getSummary(context.get('user').id)

    return context.json(summary)
})
