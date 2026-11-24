export type AdmissionResult =
    | { kind: 'admitted' }
    | { kind: 'replay' }
    | { kind: 'already-closed'; state: 'captured' | 'released' }
    | { kind: 'insufficient-credits' }
    | { kind: 'amount-conflict' }

export interface CreditReservationRepository {
    reserve(userId: string, operationId: string, amount: number): Promise<AdmissionResult>
}
