import { defineConfig } from 'vitest/config'

// E2E suite. Runs only via `pnpm test:e2e`. Assumes a localnet
// `ligate-node` is reachable at `LIGATE_E2E_RPC` (default
// `http://localhost:12346`). Tests skip themselves with a clear
// "set LIGATE_E2E_RPC to enable" message if no chain is reachable,
// so accidentally running this without a node up doesn't hang or
// fail mysteriously.
//
// Boot a localnet for testing from the chain repo:
//
//   cd ~/Desktop/ligate-chain
//   cargo run --bin ligate-node
//
// Then in this repo:
//
//   pnpm test:e2e
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    // Each e2e flow involves at least one ~12-24s slot wait; give
    // generous per-test budgets so polling-based assertions don't
    // time out on a slow boot.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run e2e tests serially. Multiple in-flight transfers from the
    // same dev key would race on the nonce; sequential isolation is
    // simpler than per-test nonce coordination for v0.
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
})
