import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, text, uniqueIndex, snakeCase } from 'drizzle-orm/sqlite-core'

// Table-level text primary keys keep explicit NOT NULL constraints in Kit's SQLite output.
export const user = snakeCase.table(
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
        updatedAt: integer({ mode: 'timestamp_ms' }).notNull(),
    },
    table => [primaryKey({ columns: [table.id] })],
)

export const session = snakeCase.table(
    'sessions',
    {
        id: text().notNull(),
        expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
        token: text().notNull().unique(),
        ipAddress: text(),
        userAgent: text(),
        userId: text()
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
        updatedAt: integer({ mode: 'timestamp_ms' }).notNull(),
    },
    table => [primaryKey({ columns: [table.id] }), index('sessions_user_id_idx').on(table.userId)],
)

export const account = snakeCase.table(
    'accounts',
    {
        id: text().notNull(),
        accountId: text().notNull(),
        providerId: text().notNull(),
        userId: text()
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        accessToken: text(),
        refreshToken: text(),
        idToken: text(),
        accessTokenExpiresAt: integer({ mode: 'timestamp_ms' }),
        refreshTokenExpiresAt: integer({ mode: 'timestamp_ms' }),
        scope: text(),
        password: text(),
        createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
        updatedAt: integer({ mode: 'timestamp_ms' }).notNull(),
    },
    table => [
        primaryKey({ columns: [table.id] }),
        index('accounts_user_id_idx').on(table.userId),
        uniqueIndex('accounts_provider_account_uidx').on(table.providerId, table.accountId),
    ],
)

export const verification = snakeCase.table(
    'verifications',
    {
        id: text().notNull(),
        identifier: text().notNull(),
        value: text().notNull(),
        expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
        createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
        updatedAt: integer({ mode: 'timestamp_ms' }).notNull(),
    },
    table => [primaryKey({ columns: [table.id] }), index('verifications_identifier_idx').on(table.identifier)],
)

export const rateLimit = snakeCase.table(
    'auth_rate_limits',
    {
        id: text().notNull(),
        key: text().notNull().unique(),
        count: integer().notNull(),
        lastRequest: integer().notNull(),
    },
    table => [primaryKey({ columns: [table.id] })],
)

export const creditAccount = snakeCase.table(
    'credit_accounts',
    {
        userId: text()
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        reserved: integer('reserved').notNull().default(0),
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
    table => [primaryKey({ columns: [table.userId] })],
)

// Balance movements are appended; corrections are new entries rather than edits to history.
export const creditLedger = snakeCase.table(
    'credit_ledger',
    {
        id: text().notNull(),
        userId: text()
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
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

export const creditReservations = snakeCase.table(
    'credit_reservations',
    {
        userId: text()
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
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
            sql`${table.amount} > 0`,
        ),
        primaryKey({ columns: [table.userId, table.operationId] }),
    ],
)
