import { check, integer, primaryKey, snakeCase, text } from 'drizzle-orm/sqlite-core'
import { users } from './users.ts'
import { sql } from 'drizzle-orm'

export const creditReservations = snakeCase.table(
    'credit_reservations',
    {
        userId: text()
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        operationId: text().notNull(),
        amount: integer().notNull(),
        state: text({ enum: ['reserved', 'captured', 'released'] }).notNull(),
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
    table => [
        check(
            'credit_reservation_state_valid',
            // language=SQLite prefix="SELECT 1 WHERE "
            sql`${table.state} in ('reserved', 'captured', 'released')`,
        ),
        check(
            'credit_reservation_amount_positive',
            // language=SQLite prefix="SELECT 1 WHERE "
            sql`typeof(${table.amount}) = 'integer' and ${table.amount} between 1 and ${Number.MAX_SAFE_INTEGER}`.inlineParams(),
        ),
        primaryKey({ columns: [table.userId, table.operationId] }),
    ],
)
