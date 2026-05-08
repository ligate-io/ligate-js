/**
 * HTTP client for Ligate Chain.
 *
 * Wraps the chain's REST surface (`/v1/...`) so callers don't have to
 * remember exact paths, response shapes, or the `/v1` prefix dance.
 *
 * **The `/v1` prefix is auto-appended** to whatever URL the caller
 * passes to [`LigateClient`]. The chain mounts every public route
 * under `/v1/` (chain #149), but the SDK's `Submitter::new` probes
 * unprefixed `/modules`, so consumers historically had to remember to
 * pass `http://host:port/v1` explicitly. The Rust cli + faucet now
 * normalize this in their entrypoints (cli #7 / faucet #5); we mirror
 * the same idempotent-append behaviour here.
 */

import { bytesToHex } from './keys.js'
import { tokenIdToBech32m } from './token.js'

/** Default per-tx fee envelope (nano-LGT). 0.1 LGT — generous for devnet. */
export const DEFAULT_MAX_FEE_NANO = 100_000_000n

/** Shape of `GET /v1/rollup/info`. */
export interface RollupInfo {
  /** Cosmos-style chain identifier from the `[chain]` config section. */
  chain_id: string
  /** Build-time `CHAIN_HASH`, hex-encoded (lowercase, 64 chars, no `0x`). */
  chain_hash: string
  /** `ligate-node` binary semver. */
  version: string
}

/** Shape of `GET /v1/modules/bank/tokens/{token_id}/balances/{address}`. */
export interface CoinsResponse {
  /** Token id, bech32m `token_1...` form. */
  token_id: string
  /** Amount as a string of decimal digits (since u128 doesn't fit in `number`). */
  amount: string
}

/** Options for [`LigateClient`] construction. */
export interface LigateClientOptions {
  /**
   * Base RPC URL. The `/v1` prefix is added automatically if absent.
   * Examples: `http://localhost:12346`, `http://localhost:12346/v1`,
   * `https://rpc.devnet.ligate.io`.
   */
  rpcUrl: string
  /**
   * Fetch implementation. Defaults to globalThis `fetch` (Node 20+,
   * browsers, edge runtimes). Override for tests or custom transports.
   */
  fetch?: typeof globalThis.fetch
}

/**
 * Read-only HTTP client for Ligate Chain.
 *
 * Construct once per RPC endpoint and reuse. Methods are stateless;
 * each call hits the chain freshly.
 */
export class LigateClient {
  /** RPC base, with `/v1` already appended. */
  readonly baseUrl: string
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: LigateClientOptions) {
    this.baseUrl = appendV1(options.rpcUrl)
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** Fetch the chain identity (chain id, chain hash, node version). */
  async getRollupInfo(): Promise<RollupInfo> {
    return this.getJson<RollupInfo>('/rollup/info')
  }

  /**
   * Fetch the next nonce for a given Ed25519 public key.
   *
   * Uses the chain's purpose-built dedup endpoint
   * `GET /v1/rollup/addresses/{credential_id}/dedup` (the `dedup`
   * action of the `SovereignDeDupEndpoint`). For `MockZkvmCryptoSpec`,
   * `credential_id` is the raw 32-byte public key hex-encoded.
   *
   * Returns `0n` if the address has never sent a transaction (the
   * endpoint reports `{"nonce": 0}` for un-seen credential ids).
   *
   * Note: the upstream Sovereign SDK's `NodeClient::get_nonce_for_public_key`
   * still hits the legacy `/modules/nonces/state/...` path (the module
   * has since been renamed to `uniqueness`), so it silently returns 0
   * even when the on-chain nonce has advanced. This SDK uses the
   * `/dedup` endpoint instead, which is the documented API surface.
   */
  async getNonce(publicKey: Uint8Array): Promise<bigint> {
    if (publicKey.length !== 32) {
      throw new Error(`expected 32-byte public key, got ${publicKey.length}`)
    }
    const credentialId = bytesToHex(publicKey)
    const url = `${this.baseUrl}/rollup/addresses/${credentialId}/dedup`
    const res = await this.fetchImpl(url)
    if (res.status === 404) {
      // Address has never been seen. The chain treats absent state as nonce = 0.
      return 0n
    }
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`)
    }
    // The dedup endpoint returns {"nonce": <u64>} (or "{generation": <u64>}"
    // when called with `?select=generation`; we always want the nonce form).
    const body = (await res.json()) as { nonce?: number | string }
    if (body.nonce === undefined || body.nonce === null) {
      return 0n
    }
    return BigInt(body.nonce)
  }

  /**
   * Fetch the `$LGT`-equivalent balance of `address` for `tokenId`.
   *
   * Returns the amount in nano-LGT. Returns `0n` if the chain has no
   * record of the address holding that token.
   *
   * `tokenId` accepts the same three forms as [`signTransfer`]: 64-char
   * hex string, `Uint8Array` of length 32, or `token_1...` bech32m
   * string. The chain's REST URLs use the bech32m form, so we
   * normalise via [`tokenIdToBech32m`] before constructing the request.
   */
  async getBalance(address: string, tokenId: string | Uint8Array): Promise<bigint> {
    const tokenIdBech32 = tokenIdToBech32m(tokenId)
    const url = `${this.baseUrl}/modules/bank/tokens/${tokenIdBech32}/balances/${address}`
    const res = await this.fetchImpl(url)
    if (res.status === 404) {
      return 0n
    }
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as CoinsResponse
    return BigInt(body.amount)
  }

  /**
   * Low-level HTTP GET that returns parsed JSON. Throws on non-2xx.
   *
   * Exposed for one-off calls to endpoints the typed methods don't yet
   * cover. Prefer the typed methods when available.
   */
  async getJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const res = await this.fetchImpl(url)
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`)
    }
    return (await res.json()) as T
  }

  /**
   * Low-level HTTP GET that returns the raw `Response`. Useful for
   * polling endpoints where 404 is a normal "not yet" signal (e.g.
   * `/ledger/txs/{hash}` while waiting for inclusion).
   */
  async getRaw(path: string): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`)
  }

  /**
   * Low-level HTTP POST that returns parsed JSON. Throws on non-2xx.
   *
   * Used by [`submitTransfer`] / [`submitRawTx`]; rarely called
   * directly.
   */
  async postJson<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`POST ${url} failed: ${res.status} ${await res.text()}`)
    }
    return (await res.json()) as T
  }
}

/**
 * Idempotent `/v1` suffix append.
 *
 * Mirrors the Rust cli's `GlobalArgs::rpc_with_v1` and faucet's
 * `Signer::new` so both ecosystems normalize the same way:
 * - `http://host:port` → `http://host:port/v1`
 * - `http://host:port/` → `http://host:port/v1`
 * - `http://host:port/v1` → `http://host:port/v1` (unchanged)
 * - `http://host:port/v1/` → `http://host:port/v1` (trailing slash stripped)
 */
export function appendV1(rpc: string): string {
  const trimmed = rpc.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}
