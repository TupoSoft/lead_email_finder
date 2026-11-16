import type { DBAdapterInstance, DBTransactionAdapter } from 'better-auth'

function isUniqueConflict(error: unknown, columns: string): boolean {
    const visited = new Set<unknown>()
    let current = error

    while (current instanceof Error && !visited.has(current)) {
        visited.add(current)

        if (current.message.includes(`UNIQUE constraint failed: ${columns}`)) {
            return true
        }

        current = current.cause
    }

    return false
}

function wrapIdentityWrites(adapter: DBTransactionAdapter): DBTransactionAdapter {
    return {
        ...adapter,
        async create<T extends Record<string, unknown>, R = T>(input: {
            model: string
            data: Omit<T, 'id'>
            select?: string[]
            forceAllowId?: boolean
        }): Promise<R> {
            try {
                return await adapter.create<T, R>(input)
            } catch (error) {
                const data: Record<string, unknown> = input.data

                if (
                    input.model === 'user' &&
                    data.emailVerified === true &&
                    typeof data.email === 'string' &&
                    isUniqueConflict(error, 'users.email')
                ) {
                    const email = data.email.toLowerCase()
                    const where = [
                        { field: 'email', value: email },
                        { field: 'emailVerified', value: true },
                    ]
                    const existing = await adapter.findOne<R & { email: string; emailVerified: boolean }>({
                        model: 'user',
                        where,
                    })

                    // An unverified local account cannot gain an OAuth binding through race recovery.
                    if (existing?.email === email && existing.emailVerified === true) {
                        if (!input.select) {
                            return existing
                        }

                        const selected = await adapter.findOne<R>({ model: 'user', where, select: input.select })

                        if (selected) {
                            return selected
                        }
                    }
                }

                if (
                    input.model === 'account' &&
                    typeof data.providerId === 'string' &&
                    typeof data.accountId === 'string' &&
                    typeof data.userId === 'string' &&
                    isUniqueConflict(error, 'accounts.provider_id, accounts.account_id')
                ) {
                    const existing = await adapter.findOne<R>({
                        model: 'account',
                        where: [
                            { field: 'providerId', value: data.providerId },
                            { field: 'accountId', value: data.accountId },
                            { field: 'userId', value: data.userId },
                        ],
                        select: input.select,
                    })

                    if (existing) {
                        return existing
                    }
                }

                throw error
            }
        },
    }
}

/** Reconcile concurrent, already-verified signups after the database selects the canonical identity. */
export function wrapCanonicalIdentityAdapter(base: DBAdapterInstance): DBAdapterInstance {
    return options => {
        const adapter = base(options)

        return {
            ...wrapIdentityWrites(adapter),
            // Better Auth scopes OAuth provisioning to this adapter even when D1 has no transaction support.
            transaction: callback => adapter.transaction(transaction => callback(wrapIdentityWrites(transaction))),
        }
    }
}
