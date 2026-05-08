import { defineConfig } from 'vitest/config'

// `pnpm test` runs only the unit-test suite under `test/`. The e2e
// suite at `e2e/` requires a running localnet (`ligate-node`) and
// is opt-in via `pnpm test:e2e` instead. Splitting the configs keeps
// `test` fast (~400ms wall) and lets CI run the unit suite without
// chain infra.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
