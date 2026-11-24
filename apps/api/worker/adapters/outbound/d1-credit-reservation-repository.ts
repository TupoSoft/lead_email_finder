import { AdmissionResult, CreditReservationRepository } from '@/application/ports/credit-reservation-repository'
import { Database } from '@/database/connection.ts'
import { sql } from 'drizzle-orm'
import { creditReservations } from '@/database/schema/credit-reservations.ts'

type ReservationReceipt = Pick<typeof creditReservations.$inferSelect, 'amount' | 'state'>

export class D1CreditReservationRepository implements CreditReservationRepository {
    constructor(private readonly database: Database) {}

    async reserve(userId: string, operationId: string, amount: number): Promise<AdmissionResult> {
        if (operationId.trim() === '') {
            throw new Error("The operationId is required and can't be blank")
        }

        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new Error('The amount must be a positive safe integer')
        }

        const result = await this.insertReservation(userId, operationId, amount)

        if (result === undefined) {
            const existing = await this.getExistingReservation(userId, operationId)

            if (existing === undefined) {
                return { kind: 'insufficient-credits' }
            }

            if (existing.amount !== amount) {
                return { kind: 'amount-conflict' }
            }

            if (existing.state === 'captured' || existing.state === 'released') {
                return { kind: 'already-closed', state: existing.state }
            }

            return { kind: 'replay' }
        }

        return { kind: 'admitted' }
    }

    private async insertReservation(
        userId: string,
        operationId: string,
        amount: number,
    ): Promise<ReservationReceipt | undefined> {
        return await this.database.get<ReservationReceipt>(
            sql`
                insert into credit_reservations (user_id, operation_id, amount, state)
                select ${userId}, ${operationId}, ${amount}, 'reserved'
                where (select coalesce(sum(delta), 0) from credit_ledger where user_id = ${userId}) -
                      (select coalesce(sum(amount), 0)
                       from credit_reservations
                       where user_id = ${userId}
                         and state = 'reserved') >= ${amount}
                on conflict (user_id, operation_id) do nothing
                returning amount, state
            `,
        )
    }

    private async getExistingReservation(userId: string, operationId: string): Promise<ReservationReceipt | undefined> {
        return await this.database.get<ReservationReceipt>(
            sql`select amount, state
                from credit_reservations
                where user_id = ${userId}
                  and operation_id = ${operationId}`,
        )
    }
}
