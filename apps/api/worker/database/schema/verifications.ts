import { index, integer, primaryKey, snakeCase, text } from 'drizzle-orm/sqlite-core'

export const verifications = snakeCase.table(
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
