import type { SQL } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { SQLiteDialect } from 'drizzle-orm/sqlite-core'

export type Database = DrizzleD1Database & {
    batchSql(statements: readonly SQL[]): Promise<void>
}

export function createDatabase(binding: D1Database): Database {
    const database = drizzle(binding)
    const dialect = new SQLiteDialect()

    return Object.assign(database, {
        async batchSql(statements: readonly SQL[]): Promise<void> {
            const prepared = statements.map(statement => {
                const query = dialect.sqlToQuery(statement)

                return binding.prepare(query.sql).bind(...query.params)
            })

            await binding.batch(prepared)
        },
    })
}
