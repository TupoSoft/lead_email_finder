import type { MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'

export const requestLogging: MiddlewareHandler = async (context, next) => {
    const requestId = crypto.randomUUID()
    const startedAt = performance.now()

    context.set('requestId', requestId)
    context.header('X-Request-Id', requestId)

    await next()

    const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)$/.test(context.req.method)
        ? context.req.method
        : 'OTHER'
    const matchedRoute = routePath(context, -1)
    const route = matchedRoute === '*' || matchedRoute === '/*' || matchedRoute === '' ? 'unmatched' : matchedRoute

    console.info({
        event: 'request_completed',
        requestId,
        method,
        route,
        status: context.res.status,
        durationMs: Math.round(performance.now() - startedAt),
    })
}
