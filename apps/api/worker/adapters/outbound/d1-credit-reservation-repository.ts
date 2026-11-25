import {
    AdmissionResult,
    CreditReservationRepository,
    ReleaseResult,
} from '@/application/ports/credit-reservation-repository'
import { Database } from '@/database/connection.ts'
import { sql } from 'drizzle-orm'
import { creditReservations } from '@/database/schema/credit-reservations.ts'

type ReservationReceipt = Pick<typeof creditReservations.$inferSelect, 'amount' | 'state'>

export class D1CreditReservationRepository implements CreditReservationRepository {
    constructor(private readonly database: Database) {}

    async reserve(userId: string, operationId: string, amount: number): Promise<AdmissionResult> {
        D1CreditReservationRepository.assertUserIdNotEmpty(userId)
        D1CreditReservationRepository.assertOperationIdNonEmpty(operationId)
        D1CreditReservationRepository.assertValidAmount(amount)

        const result = await this.insertReservation(userId, operationId, amount)

        if (result !== undefined) {
            return { kind: 'admitted' }
        }

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

    private static assertValidAmount(amount: number): void {
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new Error('The amount must be a positive safe integer')
        }
    }

    private static assertOperationIdNonEmpty(operationId: string): void {
        if (operationId.trim() === '') {
            throw new Error("The operationId is required and can't be blank")
        }
    }

    private static assertUserIdNotEmpty(userId: string): void {
        if (userId.trim() === '') {
            throw new Error("The userId is required and can't be blank")
        }
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

    async release(userId: string, operationId: string): Promise<ReleaseResult> {
        D1CreditReservationRepository.assertUserIdNotEmpty(userId)
        D1CreditReservationRepository.assertOperationIdNonEmpty(operationId)

        const receipt = await this.releaseReservation(userId, operationId)

        if (receipt !== undefined) {
            return { kind: 'released' }
        }

        const existing = await this.getExistingReservation(userId, operationId)

        if (existing === undefined) {
            return { kind: 'not-found' }
        }

        if (existing.state === 'captured') {
            return { kind: 'already-captured' }
        }

        if (existing.state === 'released') {
            return { kind: 'replay' }
        }

        return { kind: 'not-found' }
    }

    private async releaseReservation(userId: string, operationId: string): Promise<ReservationReceipt | undefined> {
        return await this.database.get<ReservationReceipt>(
            sql`update credit_reservations
                set state = 'released'
                where user_id = ${userId}
                  and operation_id = ${operationId}
                  and state not in ('released', 'captured')
                returning amount, state`,
        )
    }
}
