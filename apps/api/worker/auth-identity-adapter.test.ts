import assert from 'node:assert/strict'
import type { DBAdapter } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { describe, it, vi, type MockInstance } from 'vitest'
import { wrapCanonicalIdentityAdapter } from './auth-identity-adapter'
import { betterAuthOptions } from './auth-options'
import { account, user } from './database/schema'

function fixture(): {
    create: MockInstance<DBAdapter['create']>
    findOne: MockInstance<DBAdapter['findOne']>
    wrapped: DBAdapter
} {
    const adapter = drizzleAdapter(
        {},
        { provider: 'sqlite', transaction: false, schema: { user, account } },
    )(betterAuthOptions)
    const create = vi.spyOn(adapter, 'create')
    const findOne = vi.spyOn(adapter, 'findOne')
    const wrapped = wrapCanonicalIdentityAdapter(() => adapter)(betterAuthOptions)

    return { create, findOne, wrapped }
}

const verifiedUser = { id: 'canonical-user', email: 'person@example.test', emailVerified: true }
const userInput = { model: 'user', data: { email: 'person@example.test', emailVerified: true } }

describe('canonical authentication identity adapter', () => {
    it('preserves successful writes without a recovery read', async () => {
        const { create, findOne, wrapped } = fixture()
        create.mockResolvedValue(verifiedUser)

        const result = await wrapped.create(userInput)

        assert.deepEqual(result, verifiedUser)
        assert.equal(findOne.mock.calls.length, 0)
    })

    it('resolves a concurrent verified signup to the canonical verified email owner', async () => {
        const { create, findOne, wrapped } = fixture()
        const conflict = new Error('D1 write failed', { cause: new Error('UNIQUE constraint failed: users.email') })
        create.mockRejectedValue(conflict)
        findOne.mockResolvedValue(verifiedUser)

        const result = await wrapped.create(userInput)

        assert.deepEqual(result, verifiedUser)
        assert.deepEqual(findOne.mock.calls[0][0], {
            model: 'user',
            where: [
                { field: 'email', value: verifiedUser.email },
                { field: 'emailVerified', value: true },
            ],
        })
    })

    it('does not recover a signup that lacks verified incoming email', async () => {
        const { create, findOne, wrapped } = fixture()
        const conflict = new Error('UNIQUE constraint failed: users.email')
        create.mockRejectedValue(conflict)

        await assert.rejects(
            wrapped.create({ ...userInput, data: { ...userInput.data, emailVerified: false } }),
            error => {
                return error === conflict
            },
        )

        assert.equal(findOne.mock.calls.length, 0)
    })

    for (const local of [
        { ...verifiedUser, emailVerified: false },
        { ...verifiedUser, email: 'different@example.test' },
    ]) {
        it(`rejects recovery for an ineligible local identity: ${JSON.stringify(local)}`, async () => {
            const { create, findOne, wrapped } = fixture()
            const conflict = new Error('UNIQUE constraint failed: users.email')
            create.mockRejectedValue(conflict)
            findOne.mockResolvedValue(local)

            await assert.rejects(wrapped.create(userInput), error => error === conflict)
        })
    }

    it('recovers a duplicate Google account only through its existing canonical owner', async () => {
        const { create, findOne, wrapped } = fixture()
        const existingAccount = {
            id: 'canonical-account',
            providerId: 'google',
            accountId: 'google-subject',
            userId: verifiedUser.id,
        }
        create.mockRejectedValue(new Error('UNIQUE constraint failed: accounts.provider_id, accounts.account_id'))
        findOne.mockResolvedValue(existingAccount)

        const result = await wrapped.create({ model: 'account', data: existingAccount })

        assert.deepEqual(result, existingAccount)
        assert.deepEqual(findOne.mock.calls[0][0], {
            model: 'account',
            where: [
                { field: 'providerId', value: 'google' },
                { field: 'accountId', value: 'google-subject' },
                { field: 'userId', value: verifiedUser.id },
            ],
            select: undefined,
        })
    })

    it('rejects an account conflict when the requested owner has no matching account', async () => {
        const { create, findOne, wrapped } = fixture()
        const conflict = new Error('UNIQUE constraint failed: accounts.provider_id, accounts.account_id')
        create.mockRejectedValue(conflict)
        findOne.mockResolvedValue(null)

        await assert.rejects(
            wrapped.create({
                model: 'account',
                data: { providerId: 'google', accountId: 'google-subject', userId: 'different-user' },
            }),
            error => error === conflict,
        )
    })

    it('preserves unrelated write failures without querying an alternative identity', async () => {
        const { create, findOne, wrapped } = fixture()
        const failure = new Error('database unavailable')
        create.mockRejectedValue(failure)

        await assert.rejects(wrapped.create(userInput), error => error === failure)

        assert.equal(findOne.mock.calls.length, 0)
    })

    it('retains canonical identity recovery inside Better Auth transaction scoping', async () => {
        const { create, findOne, wrapped } = fixture()
        create.mockRejectedValue(new Error('UNIQUE constraint failed: users.email'))
        findOne.mockResolvedValue(verifiedUser)

        const result = await wrapped.transaction(transaction => transaction.create(userInput))

        assert.deepEqual(result, verifiedUser)
    })
})
