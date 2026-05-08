/**
 * End-to-end transfer test against a running localnet.
 *
 * This is the canary for wire-format drift between the TS SDK and
 * the Rust chain side. Stubbed-fetch tests in `test/` validate URL
 * shapes and pin discriminants, but they can't catch a borsh
 * field-order mismatch — only running against a real chain does.
 *
 * ## Boot a localnet first
 *
 * ```sh
 * cd ~/Desktop/ligate-chain
 * cargo run --bin ligate-node
 * # wait for "Sealed slot 1" log line
 * ```
 *
 * Then from this repo:
 *
 * ```sh
 * pnpm test:e2e
 * ```
 *
 * The test reads chain config from env (`LIGATE_E2E_RPC`,
 * `LIGATE_E2E_CHAIN_ID`, `LIGATE_E2E_TOKEN_ID`); defaults match
 * `ligate-chain/devnet/`'s localnet config so a fresh
 * `cargo run --bin ligate-node` works out-of-the-box.
 *
 * If the RPC isn't reachable on test start, every test SKIPS
 * (rather than failing) with a clear "set up a localnet first"
 * pointer. CI doesn't run this suite — it's opt-in via
 * `pnpm test:e2e`.
 *
 * ## What it covers
 *
 * - `getRollupInfo()` reaches the chain and returns a non-zero
 *   `chain_hash` (proves chain is live)
 * - `submitTransfer()` builds + signs + submits a 1 LGT transfer
 *   from the chain's dev key to a fresh recipient
 * - The recipient's balance reflects the transfer post-inclusion
 *
 * ## Dev key
 *
 * The chain's localnet dev key (`ligate-chain/devnet/local-dev-key.json`):
 *
 * - private_key: `0x0101...01` (32 bytes, all 0x01)
 * - address: `lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u`
 *
 * Pre-funded with 10000 LGT in `ligate-chain/devnet/genesis/bank.json`.
 * See chain repo PR #247 for the dev-key ceremony.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  generateKeypair,
  keypairFromPrivateKey,
  LigateClient,
  submitTransfer,
} from '../src/index.js'

// Dev-key constants from `ligate-chain/devnet/local-dev-key.json`.
const DEV_KEY_HEX = '0101010101010101010101010101010101010101010101010101010101010101'
const DEV_ADDRESS = 'lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u'

// Default test config — matches `ligate-chain/devnet/` localnet bring-up.
const DEFAULT_RPC = 'http://localhost:12346'
// `4242` is the localnet's `CHAIN_ID` baked into `ligate-chain/constants.toml`.
// Override via `LIGATE_E2E_CHAIN_ID` if pointing the suite at a different chain.
const DEFAULT_CHAIN_ID = 4242n
const DEFAULT_TOKEN_ID =
  process.env.LIGATE_E2E_TOKEN_ID ||
  // Localnet $LGT token id — pulled from
  // `ligate-chain/devnet/genesis/bank.json` (token_1nyl0e...).
  'token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7'

const RPC = process.env.LIGATE_E2E_RPC || DEFAULT_RPC
const CHAIN_ID = process.env.LIGATE_E2E_CHAIN_ID
  ? BigInt(process.env.LIGATE_E2E_CHAIN_ID)
  : DEFAULT_CHAIN_ID

interface ChainCtx {
  available: boolean
  reason?: string
  client?: LigateClient
  chainHash?: string
}

const ctx: ChainCtx = { available: false }

beforeAll(async () => {
  // Probe the chain. If unreachable, all tests skip with a clear
  // pointer instead of producing confusing fetch errors.
  try {
    const client = new LigateClient({ rpcUrl: RPC })
    const info = await client.getRollupInfo()
    if (!info.chain_hash || info.chain_hash === '0'.repeat(64) || info.chain_hash.length !== 64) {
      ctx.reason = `chain_hash from ${RPC} looks uninitialised: '${info.chain_hash}'`
      return
    }
    ctx.available = true
    ctx.client = client
    ctx.chainHash = info.chain_hash
    console.log(`[e2e] chain reachable at ${RPC}`)
    console.log(`[e2e]   chain_id:   ${info.chain_id}`)
    console.log(`[e2e]   chain_hash: ${info.chain_hash}`)
    console.log(`[e2e]   version:    ${info.version}`)
  } catch (e) {
    ctx.reason =
      `RPC unreachable at ${RPC}: ${e instanceof Error ? e.message : String(e)}. ` +
      `Boot a localnet first: cd ligate-chain && cargo run --bin ligate-node`
  }
})

afterAll(() => {
  if (!ctx.available) {
    console.warn(`[e2e] all tests skipped — ${ctx.reason}`)
  }
})

function skipIfNoChain(): boolean {
  if (!ctx.available) {
    console.log(`[e2e] skipping — ${ctx.reason}`)
    return true
  }
  return false
}

describe('e2e: transfer against localnet', () => {
  it('dev key derives the expected address', () => {
    const kp = keypairFromPrivateKey(DEV_KEY_HEX)
    expect(kp.address).toBe(DEV_ADDRESS)
  })

  it('chain reports a non-zero balance for the dev key', async () => {
    if (skipIfNoChain()) return
    const client = ctx.client!
    const balance = await client.getBalance(DEV_ADDRESS, DEFAULT_TOKEN_ID)
    expect(balance).toBeGreaterThan(0n)
    console.log(`[e2e] dev key balance: ${balance} nano-LGT`)
  })

  it('transfers 1 LGT from dev key to a fresh recipient and confirms inclusion', async () => {
    if (skipIfNoChain()) return
    const client = ctx.client!

    const sender = keypairFromPrivateKey(DEV_KEY_HEX)
    const recipient = generateKeypair()

    // Sanity: recipient is a fresh, never-used address.
    const recipientStartBalance = await client.getBalance(recipient.address, DEFAULT_TOKEN_ID)
    expect(recipientStartBalance).toBe(0n)

    const senderStartBalance = await client.getBalance(sender.address, DEFAULT_TOKEN_ID)
    const senderStartNonce = await client.getNonce(sender.publicKey)

    const transferAmount = 1_000_000_000n // 1 LGT

    const result = await submitTransfer({
      rpcUrl: RPC,
      privateKey: sender.privateKeyHex,
      publicKey: sender.publicKey,
      to: recipient.address,
      amountNano: transferAmount,
      tokenId: DEFAULT_TOKEN_ID,
      nonce: senderStartNonce,
      chainId: CHAIN_ID,
      chainHash: ctx.chainHash!,
      timeoutMs: 45_000,
    })

    // Chain returns hashes with a `0x` prefix; allow it.
    expect(result.txHash).toMatch(/^(0x)?[0-9a-fA-F]+$/)
    expect(result.included).toBe(true)
    console.log(`[e2e] tx included: ${result.txHash}`)

    // Recipient should now hold exactly the transferred amount.
    const recipientEndBalance = await client.getBalance(recipient.address, DEFAULT_TOKEN_ID)
    expect(recipientEndBalance).toBe(transferAmount)

    // Sender should have decreased by at least the transferred amount
    // (plus some gas fee — exact fee depends on chain config, hence the
    // `>=` not `===`).
    const senderEndBalance = await client.getBalance(sender.address, DEFAULT_TOKEN_ID)
    expect(senderStartBalance - senderEndBalance).toBeGreaterThanOrEqual(transferAmount)

    // Nonce should have advanced by exactly 1.
    const senderEndNonce = await client.getNonce(sender.publicKey)
    expect(senderEndNonce).toBe(senderStartNonce + 1n)
  })
})
