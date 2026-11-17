import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const user = sqliteTable('users', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const session = sqliteTable(
    'sessions',
    {
        id: text('id').primaryKey(),
        expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
        token: text('token').notNull().unique(),
        ipAddress: text('ip_address'),
        userAgent: text('user_agent'),
        userId: text('user_id')
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
        updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    },
    table => [index('sessions_user_id_idx').on(table.userId)],
)

export const account = sqliteTable(
    'accounts',
    {
        id: text('id').primaryKey(),
        accountId: text('account_id').notNull(),
        providerId: text('provider_id').notNull(),
        userId: text('user_id')
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        accessToken: text('access_token'),
        refreshToken: text('refresh_token'),
        idToken: text('id_token'),
        accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
        refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
        scope: text('scope'),
        password: text('password'),
        createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
        updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    },
    table => [
        index('accounts_user_id_idx').on(table.userId),
        uniqueIndex('accounts_provider_account_uidx').on(table.providerId, table.accountId),
    ],
)

export const verification = sqliteTable(
    'verifications',
    {
        id: text('id').primaryKey(),
        identifier: text('identifier').notNull(),
        value: text('value').notNull(),
        expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
        createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
        updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    },
    table => [index('verifications_identifier_idx').on(table.identifier)],
)

export const rateLimit = sqliteTable('auth_rate_limits', {
    id: text('id').primaryKey(),
    key: text('key').notNull().unique(),
    count: integer('count').notNull(),
    lastRequest: integer('last_request').notNull(),
})

export const creditAccount = sqliteTable(
    'credit_accounts',
    {
        userId: text('user_id')
            .primaryKey()
            .references(() => user.id, { onDelete: 'cascade' }),
        reserved: integer('reserved').notNull().default(0),
        createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
        updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    },
    table => [
        check(
            'credit_accounts_reserved_valid',
            // language=SQLite prefix="SELECT 1 WHERE "
            sql`typeof(${table.reserved}) = 'integer' and ${table.reserved} between 0 and 9007199254740991`,
        ),
    ],
)

// Zero is a completed provisioning decision, not a pending grant.
export const creditProvisioningReceipt = sqliteTable(
    'credit_provisioning_receipts',
    {
        userId: text('user_id')
            .primaryKey()
            .references(() => user.id, { onDelete: 'cascade' }),
        id: text('id').notNull().unique(),
        allowance: integer('allowance').notNull(),
        createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    },
    table => [
        check(
            'credit_provisioning_allowance_valid',
            // language=SQLite prefix="SELECT 1 WHERE "
            sql`typeof(${table.allowance}) = 'integer' and ${table.allowance} between 0 and 9007199254740991`,
        ),
    ],
)

// Balance movements are appended; corrections are new entries rather than edits to history.
export const creditLedger = sqliteTable(
    'credit_ledger',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => creditAccount.userId, { onDelete: 'cascade' }),
        operationId: text('operation_id').notNull(),
        delta: integer('delta').notNull(),
        reason: text('reason').notNull(),
        createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    },
    table => [
        uniqueIndex('credit_ledger_user_operation_uidx').on(table.userId, table.operationId),
        check(
            'credit_ledger_delta_valid',
            // language=SQLite prefix="SELECT 1 WHERE "
            sql`typeof(${table.delta}) = 'integer' and ${table.delta} between -9007199254740991 and 9007199254740991`,
        ),
    ],
)
