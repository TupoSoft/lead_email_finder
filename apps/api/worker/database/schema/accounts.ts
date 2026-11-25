import { index, integer, primaryKey, snakeCase, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from './users.ts'
import { sql } from 'drizzle-orm'

export const accounts = snakeCase.table(
    'accounts',
    {
        id: text().notNull(),
        accountId: text().notNull(),
        providerId: text().notNull(),
        userId: text()
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        accessToken: text(),
        refreshToken: text(),
        idToken: text(),
        accessTokenExpiresAt: integer({ mode: 'timestamp_ms' }),
        refreshTokenExpiresAt: integer({ mode: 'timestamp_ms' }),
        scope: text(),
        password: text(),
        createdAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .default(
                // language=SQLite prefix="select 1 where "
                sql`(unixepoch('subsecond') * 1000)`,
            ),
        updatedAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .default(
                // language=SQLite prefix="select 1 where "
                sql`
                (unixepoch('subsecond') * 1000)`,
            ),
    },
    table => [
        primaryKey({ columns: [table.id] }),
        index('accounts_user_id_idx').on(table.userId),
        uniqueIndex('accounts_provider_account_uidx').on(table.providerId, table.accountId),
    ],
)
