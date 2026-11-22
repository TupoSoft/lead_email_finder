export interface ReservationItem {
    readonly operationId: string
    readonly amount: number
}

export type AdmissionResult = { kind: 'admitted' } | { kind: 'insufficient-credits' }

export interface CreditReservationRepository {
    reserveMany(userId: string, items: readonly ReservationItem[]): Promise<AdmissionResult>
}
