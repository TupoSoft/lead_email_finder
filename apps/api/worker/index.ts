import { env } from 'cloudflare:workers'
import app from './app'
import { environmentSchema } from './environment'

// Fail before serving requests. Auth handlers still validate current bindings after configuration changes.
environmentSchema.parse(env)

export default app satisfies ExportedHandler<Env>
