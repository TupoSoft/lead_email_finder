import { integer, primaryKey, snakeCase, text } from 'drizzle-orm/sqlite-core'

export const authRateLimits = snakeCase.table(
    'auth_rate_limits',
    {
        id: text().notNull(),
        key: text().notNull().unique(),
        count: integer().notNull(),
        lastRequest: integer().notNull(),
    },
    table => [primaryKey({ columns: [table.id] })],
)
