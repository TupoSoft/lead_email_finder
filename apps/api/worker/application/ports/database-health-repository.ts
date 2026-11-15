export interface DatabaseHealthRepository {
    check(): Promise<void>
}
