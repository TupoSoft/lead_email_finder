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

        // The unique user receipt selects the winning allowance. Its attempt ID gates the
        // ledger append, so the account, receipt, and initial movement commit together once.
        const statements = [
            sql`
                insert into credit_accounts (user_id, reserved, created_at, updated_at)
                select id, 0, ${now}, ${now} from users
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
                insert into credit_ledger (id, user_id, operation_id, delta, reason, created_at)
                select id, user_id, 'initial-allowance', allowance, 'initial_allowance', created_at
                from credit_provisioning_receipts
                where user_id = ${userId} and id = ${receiptId}
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
            select coalesce(sum(ledger.delta), 0) as balance, account.reserved,
                   coalesce(sum(ledger.delta), 0) - account.reserved as available
            from credit_accounts as account
            left join credit_ledger as ledger on ledger.user_id = account.user_id
            where account.user_id = ${userId}
            group by account.user_id, account.reserved
        `)

        if (!summary) {
            throw new Error('The personal credit account has not been provisioned.')
        }

        const validAmounts = [summary.balance, summary.reserved, summary.available].every(
            amount => Number.isSafeInteger(amount) && amount >= 0,
        )

        if (!validAmounts) {
            throw new Error('The personal credit ledger has an invalid balance or reservation.')
        }

        return summary
    }
}
