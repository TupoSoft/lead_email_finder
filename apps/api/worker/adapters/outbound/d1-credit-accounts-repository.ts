import { sql } from 'drizzle-orm'
import type { CreditAccountsRepository, CreditSummary } from '@/application/ports/credit-accounts-repository'
import type { Database } from '@/database/connection'

export class D1CreditAccountsRepository implements CreditAccountsRepository {
    constructor(private readonly database: Database) {}

    async provision(userId: string, allowance: number): Promise<void> {
        if (!Number.isSafeInteger(allowance) || allowance < 0) {
            throw new Error('The initial credit allowance must be a nonnegative safe integer.')
        }

        const entryId = crypto.randomUUID()
        const now = Date.now()

        // The unique initial ledger entry is the provisioning receipt, including zero.
        await this.database.batchSql([
            sql`
                insert into credit_accounts (user_id, reserved, created_at, updated_at)
                select id, 0, ${now}, ${now} from users
                where id = ${userId} and email_verified = 1
                on conflict (user_id) do nothing
            `,
            sql`
                insert into credit_ledger (id, user_id, operation_id, delta, reason, created_at)
                select ${entryId}, id, 'initial-allowance', ${allowance}, 'initial_allowance', ${now}
                from users where id = ${userId} and email_verified = 1
                on conflict (user_id, operation_id) do nothing
            `,
        ])
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
