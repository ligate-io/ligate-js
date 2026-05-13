/**
 * Byte-level parity test against `ligate-cli`'s `transfer --print-tx-bytes`.
 *
 * Catches wire-format drift between the Rust CLI and TypeScript SDK
 * before partners hit silent failures. Both implementations sign the
 * same logical transaction (fixed dev key, fixed nonce, fixed chain
 * hash, fixed inputs); the signed-tx bytes MUST be byte-identical.
 *
 * If this test fails, either:
 *
 * - The chain renamed a field / reordered a struct / shifted a
 *   discriminant on the Rust side and the SDK hasn't picked it up yet
 *   (most common; bump the chain pin in the SDK + fix the borsh
 *   encoder)
 * - The SDK has a bug in its borsh layout (less common; debug the
 *   diff and fix the JS side)
 *
 * ## How it works
 *
 * 1. The test discovers `ligate-cli` at `LIGATE_CLI_BIN` (env var)
 *    or falls back to `cargo run` against a pinned chain checkout.
 *    CI sets `LIGATE_CLI_BIN` to a pre-built binary.
 * 2. The test runs `ligate transfer --print-tx-bytes ...` with a
 *    deterministic input vector. The CLI prints the hex-encoded
 *    signed tx to stdout, then exits.
 * 3. The test runs `signTransfer` on the JS side with the same
 *    inputs.
 * 4. Both hex strings get sliced at the signature boundary (Ed25519
 *    signatures are deterministic per RFC 8032 so they should match,
 *    but the public-content + signature is the strongest comparison
 *    surface; if signatures differ we know it's a sign-input drift
 *    rather than borsh-layout drift).
 * 5. Byte-equal assert.
 *
 * ## Skipping locally
 *
 * When `LIGATE_CLI_BIN` is unset and `cargo` isn't reachable, the
 * test SKIPS (rather than fails) — same pattern as `e2e/transfer.e2e.test.ts`.
 * CI is the canonical place this runs; local dev can opt in by setting
 * `LIGATE_CLI_BIN=/path/to/ligate-cli` before `pnpm test:parity`.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import {
  bytesToHex,
  DEFAULT_MAX_FEE_NANO,
  keypairFromPrivateKey,
  signTransfer,
} from '../src/index.js'

// Canonical dev-key vector + localnet chain config. Same constants as
// `e2e/transfer.e2e.test.ts`; keeps the parity test aligned with the
// existing live-chain smoke.
const DEV_KEY_HEX = '01'.repeat(32)
const RECIPIENT = 'lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u'
const AMOUNT_NANO = 1_000_000_000n // 1 LGT
const NONCE = 0n
const CHAIN_ID = 4242n
const CHAIN_HASH = 'lsch1amq80arndh6zehd4gu3kg6x66vh3l45z924dr6pzeevkxp649heqe5c70v'
const TOKEN_ID = 'token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7'

/** Locate the ligate-cli binary. */
function locateCli(): string | null {
  // 1. Explicit env var (set by CI in the cli-parity workflow).
  if (process.env.LIGATE_CLI_BIN) {
    return process.env.LIGATE_CLI_BIN
  }
  // 2. Try `ligate` on PATH (operator local install path).
  try {
    execFileSync('which', ['ligate'], { stdio: 'pipe' })
    return 'ligate'
  } catch {
    // 3. No CLI reachable; skip.
    return null
  }
}

/**
 * Invoke `ligate-cli transfer --print-tx-bytes` with the test vector
 * and return the hex output. The CLI prints a single line of hex to
 * stdout; we strip whitespace and return it.
 */
function cliSignedBytesHex(cli: string): string {
  const out = execFileSync(
    cli,
    [
      // The `--rpc` arg is required by the CLI's GlobalArgs even in
      // offline mode; pass a syntactically-valid URL that won't get
      // hit (since --print-tx-bytes skips the RPC roundtrip).
      '--rpc',
      'http://127.0.0.1:0',
      'transfer',
      '--print-tx-bytes',
      '--private-key-hex',
      DEV_KEY_HEX,
      '--nonce',
      String(NONCE),
      '--to',
      RECIPIENT,
      '--amount-nano',
      String(AMOUNT_NANO),
      '--chain-id',
      String(CHAIN_ID),
      '--chain-hash',
      CHAIN_HASH,
      '--token-id',
      TOKEN_ID,
    ],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        // The CLI's sov-* deps trip on the chain's risc0 build script
        // even in `transfer` (which doesn't need ZK); set the same
        // env CI uses for the chain repo so the binary can launch.
        SKIP_GUEST_BUILD: '1',
        RISC0_SKIP_BUILD_KERNELS: '1',
      },
    },
  )
    .toString()
    .trim()
  return out
}

/** Run the JS-side equivalent and return hex. */
function jsSignedBytesHex(): string {
  const sender = keypairFromPrivateKey(DEV_KEY_HEX)
  const bytes = signTransfer({
    privateKey: DEV_KEY_HEX,
    publicKey: sender.publicKey,
    to: RECIPIENT,
    amountNano: AMOUNT_NANO,
    tokenId: TOKEN_ID,
    nonce: NONCE,
    chainId: CHAIN_ID,
    chainHash: CHAIN_HASH,
    maxFeeNano: DEFAULT_MAX_FEE_NANO,
  })
  return bytesToHex(bytes)
}

describe('byte-level parity vs ligate-cli (ligate-js#18)', () => {
  const cli = locateCli()
  if (!cli) {
    it.skip('skip: ligate-cli not reachable (set LIGATE_CLI_BIN or put `ligate` on PATH)', () => {})
    return
  }

  it('signed-tx bytes are byte-identical between CLI and SDK for the canonical dev vector', () => {
    const cliHex = cliSignedBytesHex(cli)
    const jsHex = jsSignedBytesHex()

    expect(jsHex.length).toBeGreaterThan(200) // sanity: not empty
    expect(cliHex.length).toBeGreaterThan(200)

    if (cliHex !== jsHex) {
      // Surface a useful diff: show the first differing nibble pair.
      let first = -1
      const min = Math.min(cliHex.length, jsHex.length)
      for (let i = 0; i < min; i++) {
        if (cliHex[i] !== jsHex[i]) {
          first = i
          break
        }
      }
      const context = 32
      const start = Math.max(0, first - context)
      const end = Math.min(min, first + context)
      // eslint-disable-next-line no-console
      console.error(
        `bytes diverge at nibble offset ${first} (byte ${first >> 1}):\n` +
          `  cli[${start}..${end}]: ${cliHex.slice(start, end)}\n` +
          `  js [${start}..${end}]: ${jsHex.slice(start, end)}\n` +
          `  cli length: ${cliHex.length}, js length: ${jsHex.length}`,
      )
    }

    expect(jsHex).toBe(cliHex)
  })
})
