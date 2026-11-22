import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import { D1CreditAccountsRepository } from './d1-credit-accounts-repository'
import { createDatabase, type Database } from '@/database/connection'
import { D1CreditReservationRepository } from '@/adapters/outbound/d1-credit-reservation-repository.ts'

let platform: PlatformProxy<Pick<Env, 'DB'>>
let database: Database
let credits: D1CreditAccountsRepository
let reservations: D1CreditReservationRepository

const userIds: string[] = []

async function createUser(allowance: number): Promise<string> {
    const userId = randomUUID()
    const now = Date.now()

    await database.run(sql`
        INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
        VALUES (
            ${userId},
            'Test User',
            ${`${userId}@example.test`},
            1,
            ${now},
            ${now}
        )
    `)

    userIds.push(userId)
    await credits.provision(userId, allowance)

    return userId
}

beforeAll(async () => {
    platform = await getPlatformProxy<Pick<Env, 'DB'>>({
        configPath: resolve(import.meta.dirname, '../../../wrangler.jsonc'),
        persist: {
            path: resolve(import.meta.dirname, '../../../.wrangler/state/test/v3'),
        },
        remoteBindings: false,
        envFiles: [],
    })

    database = createDatabase(platform.env.DB)
    credits = new D1CreditAccountsRepository(database)
    reservations = new D1CreditReservationRepository(database)
})

afterEach(async () => {
    for (const userId of userIds) {
        await database.run(sql`DELETE FROM users WHERE id = ${userId}`)
    }

    userIds.length = 0
})

afterAll(async () => {
    await platform?.dispose()
})

describe('D1CreditReservationsRepository', () => {
    describe('reserveMany', () => {
        it('reserves credits without changing the ledger balance', async () => {
            const userId = await createUser(5)

            const result = await reservations.reserveMany(userId, [{ operationId: 'verification-1', amount: 1 }])

            assert.deepEqual(result, { kind: 'admitted' })

            const receipt = await database.get(sql`
                SELECT amount, state
                FROM credit_reservations
                WHERE user_id = ${userId}
                  AND operation_id = 'verification-1'
            `)

            assert.deepEqual(receipt, {
                amount: 1,
                state: 'reserved',
            })

            assert.deepEqual(await credits.getSummary(userId), {
                balance: 5,
                reserved: 1,
                available: 4,
            })
        })
    })
})
