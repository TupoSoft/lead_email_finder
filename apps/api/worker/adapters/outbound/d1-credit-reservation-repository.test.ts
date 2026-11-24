import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest'
import { getPlatformProxy, type PlatformProxy } from 'wrangler'
import { D1CreditAccountsRepository } from './d1-credit-accounts-repository'
import { D1CreditReservationRepository } from './d1-credit-reservation-repository'
import type { CreditReservationRepository } from '@/application/ports/credit-reservation-repository'
import { createDatabase, type Database } from '@/database/connection'

let platform: PlatformProxy<Pick<Env, 'DB'>>
let database: Database
let credits: D1CreditAccountsRepository
let reservations: CreditReservationRepository

const userIds: string[] = []

async function createUser(allowance?: number): Promise<string> {
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

    if (allowance !== undefined) {
        await credits.provision(userId, allowance)
    }

    return userId
}

async function seedReservation(
    userId: string,
    operationId: string,
    amount: number,
    state: 'reserved' | 'captured' | 'released' = 'reserved',
): Promise<void> {
    await database.run(sql`
        INSERT INTO credit_reservations (user_id, operation_id, amount, state)
        VALUES (${userId}, ${operationId}, ${amount}, ${state})
    `)
}

async function appendCredit(userId: string, delta: number): Promise<void> {
    await database.run(sql`
        INSERT INTO credit_ledger (id, user_id, operation_id, delta, reason)
        VALUES (${randomUUID()}, ${userId}, ${randomUUID()}, ${delta}, 'test_adjustment')
    `)
}

async function creditState(userId: string): Promise<{
    receipts: Record<string, unknown>[]
    ledger: Record<string, unknown>[]
}> {
    const receipts = await database.all(sql`
        SELECT * FROM credit_reservations WHERE user_id = ${userId} ORDER BY operation_id
    `)
    const ledger = await database.all(sql`
        SELECT * FROM credit_ledger WHERE user_id = ${userId} ORDER BY operation_id
    `)

    return { receipts, ledger }
}

function assertLedgerBalanceFailure(error: unknown): true {
    assert.ok(error instanceof Error)
    assert.ok(error.cause instanceof Error)
    assert.match(error.cause.message, /Credit ledger balance exceeds safe integer range\./)

    return true
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

    await platform.env.DB.prepare('DROP TRIGGER IF EXISTS reject_credit_reservation_insert').run()
})

afterEach(async () => {
    await platform.env.DB.prepare('DROP TRIGGER IF EXISTS reject_credit_reservation_insert').run()

    for (const userId of userIds) {
        await database.run(sql`DELETE FROM users WHERE id = ${userId}`)
    }

    userIds.length = 0
})

afterAll(async () => {
    await platform?.dispose()
})

describe(D1CreditReservationRepository.name, () => {
    describe('reserve', () => {
        describe('basic reservation', () => {
            it('reserves 3 of 10 credits and leaves 7 available', async () => {
                const userId = await createUser(10)

                const result = await reservations.reserve(userId, 'verification-1', 3)

                assert.deepEqual(result, { kind: 'admitted' })
                assert.deepEqual(
                    await database.get(sql`
                        SELECT amount, state FROM credit_reservations
                        WHERE user_id = ${userId} AND operation_id = 'verification-1'
                    `),
                    { amount: 3, state: 'reserved' },
                )
                assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 3, available: 7 })
            })

            it('reserves exactly the available balance', async () => {
                const userId = await createUser(5)

                const result = await reservations.reserve(userId, 'verification-1', 5)

                assert.deepEqual(result, { kind: 'admitted' })
                assert.deepEqual(await credits.getSummary(userId), { balance: 5, reserved: 5, available: 0 })
            })

            it('rejects a reservation larger than the available balance without creating a receipt', async () => {
                const userId = await createUser(2)
                const original = await creditState(userId)

                const result = await reservations.reserve(userId, 'verification-1', 3)

                assert.deepEqual(result, { kind: 'insufficient-credits' })
                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), { balance: 2, reserved: 0, available: 2 })
            })

            it('rejects a reservation when no credits are available', async () => {
                const userId = await createUser(0)
                const original = await creditState(userId)

                const result = await reservations.reserve(userId, 'verification-1', 1)

                assert.deepEqual(result, { kind: 'insufficient-credits' })
                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), { balance: 0, reserved: 0, available: 0 })
            })

            it('changes reserved and available credits without modifying the ledger', async () => {
                const userId = await createUser(5)
                const original = await creditState(userId)

                const result = await reservations.reserve(userId, 'verification-1', 1)

                assert.deepEqual(result, { kind: 'admitted' })
                assert.deepEqual((await creditState(userId)).ledger, original.ledger)
                assert.deepEqual(await credits.getSummary(userId), { balance: 5, reserved: 1, available: 4 })
            })
        })

        describe('idempotency', () => {
            it('replays an existing reservation without creating another hold', async () => {
                const userId = await createUser(10)
                await seedReservation(userId, 'verification-1', 3)
                const original = await creditState(userId)

                const result = await reservations.reserve(userId, 'verification-1', 3)

                assert.deepEqual(result, { kind: 'replay' })
                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 3, available: 7 })
            })

            it('returns an amount conflict without changing the existing reservation', async () => {
                const userId = await createUser(10)
                await seedReservation(userId, 'verification-1', 3)
                const original = await creditState(userId)

                const result = await reservations.reserve(userId, 'verification-1', 5)

                assert.deepEqual(result, { kind: 'amount-conflict' })
                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 3, available: 7 })
            })

            for (const state of ['captured', 'released'] as const) {
                it(`does not reopen a ${state} reservation`, async () => {
                    const userId = await createUser(10)
                    await seedReservation(userId, 'verification-1', 3, state)

                    if (state === 'captured') {
                        await appendCredit(userId, -3)
                    }

                    const original = await creditState(userId)
                    const summary = await credits.getSummary(userId)

                    const result = await reservations.reserve(userId, 'verification-1', 3)

                    assert.deepEqual(result, { kind: 'already-closed', state })
                    assert.deepEqual(await creditState(userId), original)
                    assert.deepEqual(await credits.getSummary(userId), summary)
                    assert.equal(summary.reserved, 0)
                })
            }

            it('checks existing receipts before affordability when available credits are zero', async () => {
                const userId = await createUser(3)
                await seedReservation(userId, 'verification-1', 3)
                const original = await creditState(userId)

                assert.deepEqual(await credits.getSummary(userId), { balance: 3, reserved: 3, available: 0 })

                const result = await reservations.reserve(userId, 'verification-1', 3)

                assert.deepEqual(result, { kind: 'replay' })
                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), { balance: 3, reserved: 3, available: 0 })
            })

            for (const state of ['reserved', 'captured', 'released'] as const) {
                it(`returns an amount conflict for a ${state} receipt before checking state or affordability`, async () => {
                    const userId = await createUser(3)
                    await seedReservation(userId, 'verification-1', 3, state)

                    if (state !== 'reserved') {
                        await appendCredit(userId, -3)
                    }

                    const original = await creditState(userId)
                    const summary = await credits.getSummary(userId)

                    assert.equal(summary.available, 0)

                    const result = await reservations.reserve(userId, 'verification-1', 5)

                    assert.deepEqual(result, { kind: 'amount-conflict' })
                    assert.deepEqual(await creditState(userId), original)
                    assert.deepEqual(await credits.getSummary(userId), summary)
                })
            }
        })

        describe('concurrency', () => {
            it('admits only one of two concurrent reservations that would overspend', async () => {
                const userId = await createUser(5)

                const results = await Promise.allSettled([
                    reservations.reserve(userId, 'verification-1', 4),
                    reservations.reserve(userId, 'verification-2', 4),
                ])

                assert.deepEqual(
                    results
                        .map(result => {
                            assert.equal(result.status, 'fulfilled')

                            return result.value.kind
                        })
                        .sort(),
                    ['admitted', 'insufficient-credits'],
                )
                assert.equal((await creditState(userId)).receipts.length, 1)
                assert.deepEqual(await credits.getSummary(userId), { balance: 5, reserved: 4, available: 1 })
            })

            it('replays concurrent identical requests with one receipt and one hold', async () => {
                const userId = await createUser(5)

                const results = await Promise.allSettled([
                    reservations.reserve(userId, 'verification-1', 4),
                    reservations.reserve(userId, 'verification-1', 4),
                ])

                const kinds = results.map(result => {
                    assert.equal(result.status, 'fulfilled')

                    return result.value.kind
                })

                assert.deepEqual(kinds.sort(), ['admitted', 'replay'])
                assert.equal((await creditState(userId)).receipts.length, 1)
                assert.deepEqual(await credits.getSummary(userId), { balance: 5, reserved: 4, available: 1 })
            })

            it('admits one concurrent conflicting request and returns an amount conflict for the other', async () => {
                const userId = await createUser(10)
                const amounts = [3, 5]

                const results = await Promise.allSettled(
                    amounts.map(amount => reservations.reserve(userId, 'verification-1', amount)),
                )

                const kinds = results.map(result => {
                    assert.equal(result.status, 'fulfilled')

                    return result.value.kind
                })

                assert.deepEqual(kinds.sort(), ['admitted', 'amount-conflict'])

                const winningIndex = results.findIndex(
                    result => result.status === 'fulfilled' && result.value.kind === 'admitted',
                )
                const winningAmount = amounts[winningIndex]
                const stored = await creditState(userId)

                assert.equal(stored.receipts.length, 1)
                assert.partialDeepStrictEqual(stored.receipts[0], {
                    operation_id: 'verification-1',
                    amount: winningAmount,
                    state: 'reserved',
                })
                assert.deepEqual(await credits.getSummary(userId), {
                    balance: 10,
                    reserved: winningAmount,
                    available: 10 - winningAmount,
                })
            })

            it('allows users with separate balances to reserve concurrently', async () => {
                const firstUserId = await createUser(5)
                const secondUserId = await createUser(8)

                const results = await Promise.allSettled([
                    reservations.reserve(firstUserId, 'verification-1', 4),
                    reservations.reserve(secondUserId, 'verification-2', 6),
                ])

                assert.deepEqual(results, [
                    { status: 'fulfilled', value: { kind: 'admitted' } },
                    { status: 'fulfilled', value: { kind: 'admitted' } },
                ])
                assert.equal((await creditState(firstUserId)).receipts.length, 1)
                assert.equal((await creditState(secondUserId)).receipts.length, 1)
                assert.deepEqual(await credits.getSummary(firstUserId), { balance: 5, reserved: 4, available: 1 })
                assert.deepEqual(await credits.getSummary(secondUserId), { balance: 8, reserved: 6, available: 2 })
            })
        })

        describe('validation and authorization', () => {
            const invalidAmounts = [
                { name: 'zero', amount: 0 },
                { name: 'negative', amount: -1 },
                { name: 'fractional', amount: 1.5 },
                { name: 'NaN', amount: NaN },
                { name: 'positive infinity', amount: Infinity },
                { name: 'negative infinity', amount: -Infinity },
                { name: 'unsafe integer', amount: Number.MAX_SAFE_INTEGER + 1 },
            ]

            for (const { name, amount } of invalidAmounts) {
                it(`rejects an invalid amount (${name}) with a validation error and no mutation`, async () => {
                    const userId = await createUser(10)
                    const original = await creditState(userId)

                    await assert.rejects(
                        () => reservations.reserve(userId, 'verification-1', amount),
                        /positive safe integer/i,
                    )

                    assert.deepEqual(await creditState(userId), original)
                    assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 0, available: 10 })
                })
            }

            it('rejects an empty operation ID with a validation error and no mutation', async () => {
                const userId = await createUser(10)
                const original = await creditState(userId)

                await assert.rejects(() => reservations.reserve(userId, '', 1), /operation.*(?:empty|required|blank)/i)

                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 0, available: 10 })
            })

            it('denies a user with no credits and no initial-allowance receipt', async () => {
                const userId = await createUser()
                const original = await creditState(userId)

                const result = await reservations.reserve(userId, 'verification-1', 1)

                assert.deepEqual(result, { kind: 'insufficient-credits' })
                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), { balance: 0, reserved: 0, available: 0 })
            })

            it('reserves sufficient credits without an initial-allowance receipt', async () => {
                const userId = await createUser()
                await appendCredit(userId, 10)
                const original = await creditState(userId)

                assert.equal(
                    original.ledger.some(entry => entry.operation_id === 'initial-allowance'),
                    false,
                )

                const result = await reservations.reserve(userId, 'verification-1', 3)

                assert.deepEqual(result, { kind: 'admitted' })

                const stored = await creditState(userId)

                assert.equal(stored.receipts.length, 1)
                assert.partialDeepStrictEqual(stored.receipts[0], {
                    user_id: userId,
                    operation_id: 'verification-1',
                    amount: 3,
                    state: 'reserved',
                })
                assert.deepEqual(stored.ledger, original.ledger)
                assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 3, available: 7 })
            })

            it('isolates receipts with the same operation ID by user', async () => {
                const firstUserId = await createUser(5)
                const secondUserId = await createUser(8)

                const firstResult = await reservations.reserve(firstUserId, 'verification-1', 3)
                const secondResult = await reservations.reserve(secondUserId, 'verification-1', 6)

                assert.deepEqual(firstResult, { kind: 'admitted' })
                assert.deepEqual(secondResult, { kind: 'admitted' })
                assert.equal((await creditState(firstUserId)).receipts.length, 1)
                assert.equal((await creditState(secondUserId)).receipts.length, 1)
                assert.deepEqual(await credits.getSummary(firstUserId), { balance: 5, reserved: 3, available: 2 })
                assert.deepEqual(await credits.getSummary(secondUserId), { balance: 8, reserved: 6, available: 2 })
            })
        })

        describe('database integrity and failures', () => {
            it('preserves existing receipts and balances when an insert fails without leaving a partial hold', async () => {
                const userId = await createUser(10)
                await seedReservation(userId, 'existing-reservation', 2)
                const original = await creditState(userId)
                const summary = await credits.getSummary(userId)

                await platform.env.DB.prepare(
                    `CREATE TRIGGER reject_credit_reservation_insert
                     BEFORE INSERT ON credit_reservations
                     BEGIN SELECT RAISE(ABORT, 'synthetic reservation failure'); END`,
                ).run()

                await assert.rejects(() => reservations.reserve(userId, 'verification-1', 3))

                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), summary)
            })

            const negativeTotals = [
                { name: 'negative ledger balance', allowance: 10, adjustment: -11, reserved: 0 },
                { name: 'negative available balance', allowance: 10, adjustment: -8, reserved: 3 },
            ]

            for (const { name, allowance, adjustment, reserved } of negativeTotals) {
                it(`returns insufficient credits without mutation for a ${name}`, async () => {
                    const userId = await createUser(allowance)
                    await appendCredit(userId, adjustment)

                    if (reserved > 0) {
                        await seedReservation(userId, 'existing-reservation', reserved)
                    }

                    const original = await creditState(userId)

                    const result = await reservations.reserve(userId, 'verification-1', 1)

                    assert.deepEqual(result, { kind: 'insufficient-credits' })
                    assert.deepEqual(await creditState(userId), original)
                })
            }

            it('rejects a fractional reservation amount at the database boundary without changing state', async () => {
                const userId = await createUser(10)
                await seedReservation(userId, 'existing-reservation', 2)
                const original = await creditState(userId)

                await assert.rejects(() => seedReservation(userId, 'fractional-reservation', 1.5))

                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 2, available: 8 })
            })

            it('rejects a ledger insert above the maximum safe balance without changing state', async () => {
                const userId = await createUser(Number.MAX_SAFE_INTEGER - 1)
                await appendCredit(userId, 1)
                await seedReservation(userId, 'existing-reservation', 2)
                const original = await creditState(userId)
                const summary = await credits.getSummary(userId)

                assert.deepEqual(summary, {
                    balance: Number.MAX_SAFE_INTEGER,
                    reserved: 2,
                    available: Number.MAX_SAFE_INTEGER - 2,
                })

                await assert.rejects(() => appendCredit(userId, 1), assertLedgerBalanceFailure)

                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), summary)
            })

            it('rejects a ledger insert below the minimum safe balance without changing state', async () => {
                const userId = await createUser(0)
                await appendCredit(userId, Number.MIN_SAFE_INTEGER)
                const original = await creditState(userId)
                const balance = await database.get(sql`
                    select sum(delta) as balance
                    from credit_ledger
                    where user_id = ${userId}
                `)

                assert.deepEqual(balance, { balance: Number.MIN_SAFE_INTEGER })

                await assert.rejects(() => appendCredit(userId, -1), assertLedgerBalanceFailure)

                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(
                    await database.get(sql`
                        select sum(delta) as balance
                        from credit_ledger
                        where user_id = ${userId}
                    `),
                    balance,
                )
            })

            it('rolls back every row when a multirow ledger insert exceeds the safe balance', async () => {
                const userId = await createUser(Number.MAX_SAFE_INTEGER - 1)
                await seedReservation(userId, 'existing-reservation', 2)
                const original = await creditState(userId)
                const summary = await credits.getSummary(userId)

                await assert.rejects(
                    () =>
                        database.run(sql`
                        insert into credit_ledger (id, user_id, operation_id, delta, reason)
                        values
                            (${randomUUID()}, ${userId}, ${randomUUID()}, 1, 'test_adjustment'),
                            (${randomUUID()}, ${userId}, ${randomUUID()}, 1, 'test_adjustment')
                    `),
                    assertLedgerBalanceFailure,
                )

                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), summary)
            })

            it('ignores a duplicate allowance at the maximum safe balance without changing state', async () => {
                const userId = await createUser(Number.MAX_SAFE_INTEGER)
                await seedReservation(userId, 'existing-reservation', 2)
                const original = await creditState(userId)
                const summary = await credits.getSummary(userId)

                await credits.provision(userId, 1)

                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), summary)
            })

            it('preserves the unique user and operation pair across repeated calls', async () => {
                const userId = await createUser(10)
                const original = await creditState(userId)

                const firstResult = await reservations.reserve(userId, 'verification-1', 3)

                assert.deepEqual(firstResult, { kind: 'admitted' })

                for (let attempt = 0; attempt < 4; attempt += 1) {
                    const result = await reservations.reserve(userId, 'verification-1', 3)

                    assert.deepEqual(result, { kind: 'replay' })
                }

                const stored = await creditState(userId)

                assert.equal(stored.receipts.length, 1)
                assert.partialDeepStrictEqual(stored.receipts[0], {
                    operation_id: 'verification-1',
                    amount: 3,
                    state: 'reserved',
                })
                assert.deepEqual(stored.ledger, original.ledger)
                assert.deepEqual(await credits.getSummary(userId), { balance: 10, reserved: 3, available: 7 })
            })

            it('preserves an existing hold and leaves no new hold after insufficient-credit rejection', async () => {
                const userId = await createUser(5)
                await seedReservation(userId, 'existing-reservation', 3)
                const original = await creditState(userId)

                const result = await reservations.reserve(userId, 'verification-1', 3)

                assert.deepEqual(result, { kind: 'insufficient-credits' })
                assert.deepEqual(await creditState(userId), original)
                assert.deepEqual(await credits.getSummary(userId), { balance: 5, reserved: 3, available: 2 })
            })
        })
    })
})
