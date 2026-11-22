// Balance movements are appended; corrections are new entries rather than edits to history.
import { check, integer, primaryKey, snakeCase, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from './users.ts'
import { sql } from 'drizzle-orm'

export const creditLedger = snakeCase.table(
    'credit_ledger',
    {
        id: text().notNull(),
        userId: text()
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        operationId: text().notNull(),
        delta: integer().notNull(),
        reason: text().notNull(),
        createdAt: integer({ mode: 'timestamp_ms' })
            .notNull()
            .default(
                // language=SQLite prefix="SELECT 1 WHERE "
                sql`(unixepoch('subsecond') * 1000)`,
            ),
    },
    table => [
        primaryKey({ columns: [table.id] }),
        uniqueIndex('credit_ledger_user_operation_uidx').on(table.userId, table.operationId),
        check(
            'credit_ledger_delta_valid',
            // language=SQLite prefix="SELECT 1 WHERE "
            sql`typeof(${table.delta}) = 'integer' and ${table.delta} between -9007199254740991 and 9007199254740991`,
        ),
    ],
)
