import { index, integer, primaryKey, snakeCase, text } from 'drizzle-orm/sqlite-core'
import { users } from './users.ts'
import { sql } from 'drizzle-orm'

export const sessions = snakeCase.table(
    'sessions',
    {
        id: text().notNull(),
        expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
        token: text().notNull().unique(),
        ipAddress: text(),
        userAgent: text(),
        userId: text()
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        createdAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .default(
                // language=SQLite prefix="SELECT 1 WHERE "
                sql`
                    (unixepoch('subsecond') * 1000)`,
            ),
        updatedAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .default(
                // language=SQLite prefix="SELECT 1 WHERE "
                sql`(unixepoch('subsecond') * 1000)`,
            ),
    },
    table => [primaryKey({ columns: [table.id] }), index('sessions_user_id_idx').on(table.userId)],
)
