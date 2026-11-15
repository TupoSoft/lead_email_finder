import { Hono } from 'hono'
import { auth, requireApplicationMutation, requireVerifiedUser, type WorkerEnvironment } from './auth'
import { healthRoutes } from './adapters/inbound/http/routes/health-routes.ts'
import { requestLogging } from './adapters/inbound/http/middleware/request-logging.ts'

const app = new Hono<WorkerEnvironment>()

app.use(requestLogging)

app.all('/v1/auth/*', context => auth(context.env, context.get('requestId')).handler(context.req.raw))

app.use('/v1/*', requireApplicationMutation)

app.get('/v1/me', requireVerifiedUser, context => context.json({ user: context.get('user') }))

app.route('/health', healthRoutes)

app.notFound(context => context.text('Not Found', 404))

app.onError((_error, context) => {
    console.error({ event: 'request_failed', requestId: context.get('requestId') })

    return context.json({ status: 'error' }, 500)
})

export default app
