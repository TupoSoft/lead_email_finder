import { existsSync } from 'node:fs'
import { createLogger, defineConfig, loadEnv } from 'vite'
import type { Plugin, PluginOption, ProxyOptions, UserConfig, ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { isApiRequest, STATIC_SECURITY_HEADERS } from './gateway-routes.ts'

// Vite's style injection and React refresh need a nonce; this fixed value is for
// local development only and is never included in the built Nginx document.
const DEVELOPMENT_NONCE = 'lef-vite-development-only'

function createStaticHeadersPlugin(development: boolean, reactBuddyEnabled: boolean): Plugin {
    const headers: Record<string, string> = { ...STATIC_SECURITY_HEADERS }

    if (development) {
        let styleSource = `'nonce-${DEVELOPMENT_NONCE}'`

        // React Buddy injects styles without a nonce. Allow them only in the opt-in local preview.
        if (reactBuddyEnabled) {
            styleSource = "'unsafe-inline'"
        }

        headers['Content-Security-Policy'] = STATIC_SECURITY_HEADERS['Content-Security-Policy']
            .replace("script-src 'self'", `script-src 'self' 'nonce-${DEVELOPMENT_NONCE}'`)
            .replace("style-src 'self'", `style-src 'self' ${styleSource}`)
            .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*")
    }

    const configure = (server: Pick<ViteDevServer, 'middlewares'>) => {
        server.middlewares.use((request, response, next) => {
            const requestUrl = request.url ?? '/'

            if (!isApiRequest(requestUrl)) {
                for (const [name, value] of Object.entries(headers)) {
                    response.setHeader(name, value)
                }
            }

            next()
        })
    }

    return {
        name: 'static-security-headers',
        configureServer: configure,
        configurePreviewServer: configure,
    }
}

function createReactBuddyPlugin(): Plugin {
    return {
        name: 'local-react-buddy-entry',
        apply: 'serve',
        transformIndexHtml: {
            order: 'pre',
            handler(html) {
                return html.replace('src="/src/main.tsx"', 'src="/src/dev/main.tsx"')
            },
        },
    }
}

function createApplicationLogger() {
    const logger = createLogger()
    const originalError = logger.error.bind(logger)

    logger.error = (message, options) => {
        let publicMessage = message

        // Vite's default proxy error includes the raw URL and upstream error.
        if (message.includes('http proxy error')) {
            publicMessage = 'API proxy request failed'
        }

        originalError(publicMessage, options)
    }

    return logger
}

function createApiProxy(target: string): Record<string, ProxyOptions> {
    // Dispatch only the explicit API inventory. A predicate is necessary because
    // Nginx decodes paths before routing; the upstream still receives the original URL.
    return {
        '^/': {
            target,
            changeOrigin: false,
            xfwd: true,
            bypass(request) {
                const requestUrl = request.url ?? '/'

                if (isApiRequest(requestUrl)) {
                    return undefined
                }

                return requestUrl
            },
        },
    }
}

export default defineConfig(async ({ command, isPreview, mode }) => {
    const environment = loadEnv(mode, process.cwd(), '')
    const development = command === 'serve' && !isPreview
    const cloudflareBuild = process.env.LEF_CLOUDFLARE_BUILD === '1'

    let reactBuddyEnabled = false

    if (development && environment.REACT_BUDDY === '1') {
        reactBuddyEnabled = existsSync(new URL('./src/dev/main.tsx', import.meta.url))
    }

    const plugins: PluginOption[] = [react()]

    if (reactBuddyEnabled) {
        plugins.push(createReactBuddyPlugin())
    }

    // Cloudflare uses a separate build output; Docker and local suites keep dist/.
    if (cloudflareBuild) {
        const { cloudflare } = await import('@cloudflare/vite-plugin')
        plugins.push(cloudflare())
    } else {
        plugins.push(createStaticHeadersPlugin(development, reactBuddyEnabled))
    }

    const config: UserConfig = {
        plugins,
        customLogger: createApplicationLogger(),
        build: { target: 'es2022' },
    }

    if (development) {
        config.html = { cspNonce: DEVELOPMENT_NONCE }
    }

    if (!cloudflareBuild) {
        const target = environment.WEB_API_PROXY_TARGET || 'http://127.0.0.1:8787'
        const proxy = createApiProxy(target)

        config.server = { proxy }
        config.preview = { proxy }
    }

    return config
})
