import {
    AdmissionResult,
    CreditReservationRepository,
    ReservationItem,
} from '@/application/ports/credit-reservation-repository'
import { Database } from '@/database/connection.ts'
import { sql } from 'drizzle-orm'

export class D1CreditReservationRepository implements CreditReservationRepository {
    constructor(private readonly database: Database) {}

    async reserveMany(userId: string, items: readonly ReservationItem[]): Promise<AdmissionResult> {
        await this.database.batchSql(
            items.map(
                ({ operationId, amount }) =>
                    sql`insert into credit_reservations (user_id, operation_id, amount, state)
                        values (${userId}, ${operationId}, ${amount}, 'reserved')`,
            ),
        )

        return { kind: 'admitted' }
    }
}
