import { integer, primaryKey, snakeCase, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const users = snakeCase.table(
    'users',
    {
        id: text().notNull(),
        name: text().notNull(),
        email: text().notNull().unique(),
        emailVerified: integer({ mode: 'boolean' }).notNull().default(false),
        image: text(),
        createdAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .default(
                // language=SQLite prefix="SELECT 1 WHERE "
                sql`(unixepoch('subsecond') * 1000)`,
            ),
        updatedAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .default(
                // language=SQLite prefix="SELECT 1 WHERE "
                sql`(unixepoch('subsecond') * 1000)`,
            ),
    },
    table => [primaryKey({ columns: [table.id] })],
)
