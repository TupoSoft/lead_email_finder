import { Hono } from 'hono'
import { auth, requireApplicationMutation, requireVerifiedUser } from './auth'
import type { WorkerEnvironment } from './environment'
import { healthRoutes } from '@/adapters/inbound/http/routes/health-routes'
import { requestLogger } from '@/adapters/inbound/http/middleware/request-logger'
import { errorHandler } from '@/adapters/inbound/http/middleware/error-handler'
import { billingRoutes } from '@/adapters/inbound/http/routes/billing-routes'

const app = new Hono<WorkerEnvironment>()

app.use(requestLogger)
app.use('/v1/*', requireApplicationMutation)
app.all('/v1/auth/*', context => auth(context.env, context.get('requestId')).handler(context.req.raw))
app.get('/v1/me', requireVerifiedUser, context => context.json({ user: context.get('user') }))
app.route('/v1/billing', billingRoutes)
app.route('/health', healthRoutes)
app.notFound(context => context.text('Not Found', 404))
app.onError(errorHandler)

export default app
