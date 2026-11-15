import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    root: resolve(import.meta.dirname, '..'),
    test: {
        environment: 'node',
        include: ['worker/**/*.test.ts'],
        // D1 suites share the isolated test database and clear it between tests.
        fileParallelism: false,
        testTimeout: 20_000,
        hookTimeout: 30_000,
    },
})
