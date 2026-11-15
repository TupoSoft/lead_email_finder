import createClient, { type Client, type ClientOptions } from 'openapi-fetch'
import type { paths } from './schema'

export type * from './schema'
export type { ClientOptions, Middleware } from 'openapi-fetch'

export type ApiClient = Client<paths>

export function createApiClient(options: ClientOptions = {}): ApiClient {
    return createClient<paths>(options)
}
