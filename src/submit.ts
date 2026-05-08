/**
 * High-level transfer pipeline: build → sign → submit → wait.
 *
 * Mirrors the Rust cli's `transfer.rs` / faucet's `signer.rs` so the
 * three SDKs stay shape-compatible.
 *
 * ## Wire-format notes (gotchas this module hides)
 *
 * - `POST /v1/sequencer/txs` accepts the inner signed-transaction
 *   bytes; do NOT pre-wrap in `AuthenticatorInput::Standard`. The
 *   chain's `axum_accept_tx` handler wraps server-side. (See
 *   [`signTransfer`] for why.)
 *
 * - Confirmation is via HTTP polling on `/v1/ledger/txs/{hash}`, NOT
 *   the SDK's WebSocket subscription. The Rust SDK's
 *   `wait_for_tx_processing` has a URL-parsing bug (chain #245 / cli
 *   #8) that produces "invalid port value" on non-standard hosts.
 *   Polling is functionally equivalent and avoids the WS path.
 *
 * - The chain's POST body is `{ body: base64(borsh(signed_tx)) }`,
 *   `application/json` content type. Returns
 *   `{ id: <tx_hash>, status: ... }`.
 */

import { LigateClient } from './client.js'
import type { LigateClientOptions } from './client.js'
import { signTransfer } from './transaction.js'
import type { SignTransferParams } from './transaction.js'

/** Default poll interval, in milliseconds, for [`waitForInclusion`]. */
const DEFAULT_POLL_INTERVAL_MS = 500

/** Default timeout, in milliseconds, for [`waitForInclusion`]. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Inputs to [`submitTransfer`]: everything `signTransfer` needs plus the RPC URL. */
export interface SubmitTransferParams extends SignTransferParams, LigateClientOptions {
  /**
   * If `true`, poll `/v1/ledger/txs/{hash}` until the chain has indexed
   * the transaction. Defaults to `true`. Set `false` for fire-and-forget.
   */
  waitForInclusion?: boolean
  /** Override default 500ms poll interval. */
  pollIntervalMs?: number
  /** Override default 30s timeout. */
  timeoutMs?: number
}

/** Response from [`submitRawTx`] / [`submitTransfer`]. */
export interface SubmitResult {
  /** Server-returned transaction hash, hex-encoded (no `0x` prefix). */
  txHash: string
  /**
   * `true` if the tx was confirmed on-chain via polling. `false` when
   * `waitForInclusion: false` was passed (caller chose fire-and-forget).
   */
  included: boolean
}

/**
 * Build, sign, submit, and (by default) wait for inclusion.
 *
 * Convenience wrapper around [`signTransfer`] + [`submitRawTx`] +
 * [`waitForInclusion`]. Use this for the common single-shot case;
 * decompose for batched / advanced flows.
 */
export async function submitTransfer(params: SubmitTransferParams): Promise<SubmitResult> {
  const client = new LigateClient(params)
  const bytes = signTransfer(params)
  // Build the options object without setting undefined properties —
  // `exactOptionalPropertyTypes: true` treats `{ x: undefined }` as
  // distinct from `{}`, so spread-only-when-defined keeps the call
  // shape clean.
  const options: SubmitRawTxOptions = {
    waitForInclusion: params.waitForInclusion ?? true,
  }
  if (params.pollIntervalMs !== undefined) options.pollIntervalMs = params.pollIntervalMs
  if (params.timeoutMs !== undefined) options.timeoutMs = params.timeoutMs
  return submitRawTx(client, bytes, options)
}

/** Options accepted by [`submitRawTx`]. */
export interface SubmitRawTxOptions {
  waitForInclusion?: boolean
  pollIntervalMs?: number
  timeoutMs?: number
}

/**
 * Submit pre-built borsh-encoded transaction bytes to the sequencer.
 *
 * `bytes` MUST be the output of [`signTransfer`] (or equivalent — the
 * borsh-encoded `Transaction::V0(Version0)`). The server wraps in
 * `AuthenticatorInput::Standard(...)` itself; pre-wrapping
 * double-wraps and the chain rejects.
 */
export async function submitRawTx(
  client: LigateClient,
  bytes: Uint8Array,
  options: SubmitRawTxOptions = {},
): Promise<SubmitResult> {
  // The handler expects `{ body: base64(bytes) }`.
  const body = { body: bytesToBase64(bytes) }
  const response = await client.postJson<{ id: string }>('/sequencer/txs', body)
  const txHash = response.id

  const wait = options.waitForInclusion ?? true
  if (!wait) {
    return { txHash, included: false }
  }
  await waitForInclusion(client, txHash, options)
  return { txHash, included: true }
}

/**
 * Poll `/v1/ledger/txs/{hash}` until the chain has indexed the tx, or
 * the timeout fires.
 *
 * Returns once we see a 2xx response. Throws if `timeoutMs` elapses
 * without a successful read; the tx may still land later (the chain
 * just hasn't indexed it yet) — caller can retry the lookup manually
 * via [`LigateClient.getRaw`] if needed.
 */
export async function waitForInclusion(
  client: LigateClient,
  txHash: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = Date.now()
  const path = `/ledger/txs/${txHash}`

  while (true) {
    const elapsed = Date.now() - started
    if (elapsed > timeout) {
      throw new Error(
        `timed out after ${timeout}ms waiting for tx ${txHash} to be included; ` +
          `the tx may still land — retry GET ${client.baseUrl}${path} to check`,
      )
    }
    const res = await client.getRaw(path)
    if (res.ok) {
      // Drain the body so connection-reuse-friendly transports don't leak.
      await res.arrayBuffer().catch(() => undefined)
      return
    }
    // Drain non-ok bodies too.
    await res.arrayBuffer().catch(() => undefined)
    await sleep(interval)
  }
}

/** `Promise`-friendly sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Encode `Uint8Array` as a base64 string. Works in browsers, Node 20+,
 * and edge runtimes (avoids `Buffer` for portability).
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Node 20+ exposes `Buffer` globally and it's the fastest path; fall
  // back to a hand-rolled encoder for browsers/edges that lack it.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary)
}
