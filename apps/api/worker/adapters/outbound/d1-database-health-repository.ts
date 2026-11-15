import type { DatabaseHealthRepository } from '@/application/ports/database-health-repository'
import { sql } from 'drizzle-orm'
import { Database } from '@/database/connection'

export class D1DatabaseHealthRepository implements DatabaseHealthRepository {
    constructor(private readonly database: Database) {}

    async check(): Promise<void> {
        await this.database.get(sql`SELECT 1`)
    }
}
