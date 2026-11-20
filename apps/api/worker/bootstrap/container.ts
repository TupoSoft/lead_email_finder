import { D1DatabaseHealthRepository } from '@/adapters/outbound/d1-database-health-repository'
import { createDatabase } from '@/database/connection'
import type { DatabaseHealthRepository } from '@/application/ports/database-health-repository'
import type { CreditAccountsRepository } from '@/application/ports/credit-accounts-repository'
import { D1CreditAccountsRepository } from '@/adapters/outbound/d1-credit-accounts-repository'

type Bindings = {
    DB: D1Database
}

type ReturnType = {
    healthRepository: DatabaseHealthRepository
    creditAccounts: CreditAccountsRepository
}

export function createServices(env: Bindings): ReturnType {
    const database = createDatabase(env.DB)

    return {
        healthRepository: new D1DatabaseHealthRepository(database),
        creditAccounts: new D1CreditAccountsRepository(database),
    }
}
