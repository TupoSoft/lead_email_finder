export type AdmissionResult =
    | { kind: 'admitted' }
    | { kind: 'replay' }
    | { kind: 'already-closed'; state: 'captured' | 'released' }
    | { kind: 'insufficient-credits' }
    | { kind: 'amount-conflict' }

export type ReleaseResult =
    { kind: 'released' } | { kind: 'replay' } | { kind: 'already-captured' } | { kind: 'not-found' }

export interface CreditReservationRepository {
    reserve(userId: string, operationId: string, amount: number): Promise<AdmissionResult>
    release(userId: string, operationId: string): Promise<ReleaseResult>
}
