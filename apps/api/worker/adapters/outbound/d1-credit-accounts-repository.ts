import { sql } from 'drizzle-orm'
import type { CreditAccountsRepository, CreditSummary } from '@/application/ports/credit-accounts-repository'
import type { Database } from '@/database/connection'
import { DatabaseOperationError } from '@/database/database-operation-error.ts'

export class D1CreditAccountsRepository implements CreditAccountsRepository {
    constructor(private readonly database: Database) {}

    async provision(userId: string, allowance: number): Promise<void> {
        if (!Number.isSafeInteger(allowance) || allowance < 0) {
            throw new Error('The initial credit allowance must be a nonnegative safe integer.')
        }

        await this.database.run(
            sql`
                insert into credit_ledger (id, user_id, operation_id, delta, reason)
                select ${crypto.randomUUID()}, id, 'initial-allowance', ${allowance}, 'initial_allowance'
                from users
                where id = ${userId}
                  and email_verified = 1
                on conflict (user_id, operation_id) do nothing
            `,
        )
    }

    async getSummary(userId: string): Promise<CreditSummary> {
        const summary = await this.getSummaryFromDB(userId)

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

    private async getSummaryFromDB(userId: string): Promise<CreditSummary | undefined> {
        try {
            return await this.database.get<CreditSummary>(sql`
                with ledger as (select coalesce(sum(delta), 0) as balance from credit_ledger where user_id = ${userId}),
                     reservations as (select coalesce(sum(amount), 0) as reserved
                                      from credit_reservations
                                      where user_id = ${userId}
                                        and state = 'reserved')
                select balance, reserved, balance - reserved as available
                from ledger
                         cross join reservations
            `)
        } catch (error: unknown) {
            throw new DatabaseOperationError('credit_summary.read', error)
        }
    }
}
