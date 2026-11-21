export class DatabaseOperationError extends Error {
    constructor(
        readonly operation: string,
        cause: unknown,
    ) {
        super('Database operation failed', { cause })
    }
}
