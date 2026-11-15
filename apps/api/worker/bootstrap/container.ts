import { D1DatabaseHealthRepository } from '@/adapters/outbound/d1-database-health-repository'
import { createDatabase } from '@/database/connection'
import type { DatabaseHealthRepository } from '@/application/ports/database-health-repository'

type Bindings = {
    DB: D1Database
}

type ReturnType = {
    healthRepository: DatabaseHealthRepository
}

export function createServices(env: Bindings): ReturnType {
    const database = createDatabase(env.DB)

    return {
        healthRepository: new D1DatabaseHealthRepository(database),
    }
}
