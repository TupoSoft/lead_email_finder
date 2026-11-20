import type { SQL } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import * as schema from './schema'

export type Database = DrizzleD1Database<typeof schema> & {
    batchSql(statements: readonly SQL[]): Promise<void>
}

export function createDatabase(binding: D1Database): Database {
    const database = drizzle(binding, { schema })
    const dialect = new SQLiteAsyncDialect()

    return Object.assign(database, {
        // Drizzle's D1 batch mapper cannot prepare parameterized raw SQL queries.
        async batchSql(statements: readonly SQL[]): Promise<void> {
            const prepared = statements.map(statement => {
                const query = dialect.sqlToQuery(statement)

                return binding.prepare(query.sql).bind(...query.params)
            })

            await binding.batch(prepared)
        },
    })
}
