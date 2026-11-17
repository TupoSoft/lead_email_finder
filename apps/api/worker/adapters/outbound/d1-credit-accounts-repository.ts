import { sql } from 'drizzle-orm'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import type { CreditAccountsRepository, CreditSummary } from '@/application/ports/credit-accounts-repository'
import type { Database } from '@/database/connection'

export class D1CreditAccountsRepository implements CreditAccountsRepository {
    constructor(private readonly database: Database) {}

    async provision(userId: string, allowance: number): Promise<void> {
        if (!Number.isSafeInteger(allowance) || allowance < 0) {
            throw new Error('The initial credit allowance must be a nonnegative safe integer.')
        }

        const receiptId = crypto.randomUUID()
        const now = Date.now()

        // D1 batches are transactions. The unique user receipt selects the winning grant;
        // the attempt ID prevents retries or competing configurations from applying it again.
        const statements = [
            sql`
                insert into credit_accounts (user_id, balance, reserved, created_at, updated_at)
                select id, 0, 0, ${now}, ${now} from users
                where id = ${userId} and email_verified = 1
                on conflict (user_id) do nothing
            `,
            sql`
                insert into credit_provisioning_receipts (user_id, id, allowance, created_at)
                select id, ${receiptId}, ${allowance}, ${now} from users
                where id = ${userId} and email_verified = 1
                on conflict (user_id) do nothing
            `,
            sql`
                update credit_accounts
                set balance = balance + ${allowance}, updated_at = ${now}
                where user_id = ${userId} and exists (
                    select 1 from credit_provisioning_receipts
                    where user_id = ${userId} and id = ${receiptId}
                )
            `,
        ]
        const dialect = new SQLiteAsyncDialect()
        const prepared = statements.map(statement => {
            const query = dialect.sqlToQuery(statement)

            return this.database.$client.prepare(query.sql).bind(...query.params)
        })

        // Drizzle's raw sql queries are not supported by its D1 batch mapper.
        await this.database.$client.batch(prepared)
    }

    async getSummary(userId: string): Promise<CreditSummary> {
        const summary = await this.database.get<CreditSummary>(sql`
            select balance, reserved, balance - reserved as available
            from credit_accounts where user_id = ${userId}
        `)

        if (!summary) {
            throw new Error('The personal credit account has not been provisioned.')
        }

        return summary
    }
}
