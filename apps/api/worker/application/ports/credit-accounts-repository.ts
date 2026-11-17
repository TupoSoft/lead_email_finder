export interface CreditSummary {
    balance: number
    reserved: number
    available: number
}

export interface CreditAccountsRepository {
    /** Atomically record and apply the first allowance, including zero, for a verified user. */
    provision(userId: string, allowance: number): Promise<void>
    getSummary(userId: string): Promise<CreditSummary>
}
