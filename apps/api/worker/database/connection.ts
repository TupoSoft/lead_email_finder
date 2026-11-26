import type { SQL } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { SQLiteDialect } from 'drizzle-orm/sqlite-core'

type BatchSqlResults<Statements extends readonly SQL[]> = {
    -readonly [Index in keyof Statements]: Statements[Index] extends SQL<infer Row> ? D1Result<Row> : never
}

export type Database = DrizzleD1Database & {
    batchSql<const Statements extends readonly SQL[]>(statements: Statements): Promise<BatchSqlResults<Statements>>
}

export function createDatabase(binding: D1Database): Database {
    const database = drizzle(binding)
    const dialect = new SQLiteDialect()

    return Object.assign(database, {
        async batchSql<const Statements extends readonly SQL[]>(
            statements: Statements,
        ): Promise<BatchSqlResults<Statements>> {
            const prepared = statements.map(statement => {
                const query = dialect.sqlToQuery(statement)

                return binding.prepare(query.sql).bind(...query.params)
            })

            return (await binding.batch(prepared)) as BatchSqlResults<Statements>
        },
    })
}
