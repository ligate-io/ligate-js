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

/** Default per-tx fee envelope (nano-AVOW). 0.1 AVOW — generous for devnet. */
export const DEFAULT_MAX_FEE_NANO = 100_000_000n

/** Shape of `GET /v1/rollup/info`. */
export interface RollupInfo {
  /** Cosmos-style chain identifier from the `[chain]` config section. */
  chain_id: string
  /**
   * Build-time `CHAIN_HASH`. Bech32m-encoded with HRP `lsch`
   * (`lsch1...`); matches `/v1/rollup/schema` for the same value.
   * Wallets use it as the chain-identity fingerprint at signing time.
   *
   * Pass this string directly as `chainHash` to
   * [`signTransfer`] / [`wrapAndSign`] / [`submitTransfer`]; the
   * coercion helper [`chainHashToBytes`] decodes the bech32m form
   * before the signing payload is built. Legacy 64-char hex from
   * older chain revs is also accepted.
   */
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
   * `credential_id` is the 32-byte public key. The chain accepts
   * both the bech32m form (`lpk1...`) and legacy hex on the path
   * via `PubKeyBech32::FromStr`; the SDK passes through whatever
   * the caller hands it.
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
   * Fetch the `AVOW`-equivalent balance of `address` for `tokenId`.
   *
   * Returns the amount in nano-AVOW. Returns `0n` if the chain has no
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

  // ---- Indexer query methods ----------------------------------------------
  //
  // These methods talk to ligate-api's `/v1/blocks*`, `/v1/txs*`,
  // `/v1/addresses/*`, `/v1/schemas*`, `/v1/attestor-sets/*` surface
  // (see `ligate-io/ligate-api`). Point `rpcUrl` at a ligate-api
  // deployment, not the chain directly — the chain's `/v1/...` exposes
  // a different surface (sequencer/ledger/rollup) and these methods
  // would 404 against it.
  //
  // Return types are intentionally generic (`<T = unknown>` so callers
  // can narrow). The ligate-api response shapes aren't fully pinned yet
  // (the v0 indexer ships placeholders returning 501); these methods
  // will gain concrete return types once the indexer's Postgres schema
  // and serializers stabilise. Tracked at
  // https://github.com/ligate-io/ligate-api/issues/1.

  /**
   * Page through the indexer's blocks list.
   *
   * `limit` and `before` are forwarded as query-string params; the api
   * caps `limit` server-side. `before` is a cursor (block height or
   * opaque token, depending on how the indexer chooses to paginate).
   */
  async listBlocks<T = unknown>(params: { limit?: number; before?: string } = {}): Promise<T> {
    return this.getJson<T>(`/blocks${formatQuery(params)}`)
  }

  /** Fetch a single block by `height`. */
  async getBlock<T = unknown>(height: number | bigint): Promise<T> {
    return this.getJson<T>(`/blocks/${height.toString()}`)
  }

  /** Page through the indexer's transactions list. */
  async listTxs<T = unknown>(params: { limit?: number; before?: string } = {}): Promise<T> {
    return this.getJson<T>(`/txs${formatQuery(params)}`)
  }

  /**
   * Fetch a single transaction by hash.
   *
   * Accepts bech32m (`ltx1...`, the chain's canonical output form) or
   * legacy hex with or without a leading `0x`. The chain's
   * `TxHash::FromStr` resolves either. The SDK forwards whatever the
   * caller hands it without normalisation.
   */
  async getTx<T = unknown>(hash: string): Promise<T> {
    return this.getJson<T>(`/txs/${hash}`)
  }

  /**
   * Address summary (balances, recent activity, attestation counts).
   *
   * `address` is the bech32m `lig1...` form.
   */
  async getAddressSummary<T = unknown>(address: string): Promise<T> {
    return this.getJson<T>(`/addresses/${address}`)
  }

  /** Page through registered attestation schemas. */
  async listSchemas<T = unknown>(params: { limit?: number; before?: string } = {}): Promise<T> {
    return this.getJson<T>(`/schemas${formatQuery(params)}`)
  }

  /**
   * Fetch a single attestation schema by id.
   *
   * `id` accepts the bech32m `lsc1...` form (canonical) or 64-char hex.
   */
  async getSchema<T = unknown>(id: string): Promise<T> {
    return this.getJson<T>(`/schemas/${id}`)
  }

  /**
   * Fetch a single attestor set by id.
   *
   * `id` accepts the bech32m `las1...` form (canonical) or 64-char hex.
   */
  async getAttestorSet<T = unknown>(id: string): Promise<T> {
    return this.getJson<T>(`/attestor-sets/${id}`)
  }

  /** Page through registered attestor sets. */
  async listAttestorSets<T = unknown>(
    params: { limit?: number; before?: string } = {},
  ): Promise<T> {
    return this.getJson<T>(`/attestor-sets${formatQuery(params)}`)
  }

  /** Page through the indexer's attestations list. */
  async listAttestations<T = unknown>(
    params: { limit?: number; before?: string } = {},
  ): Promise<T> {
    return this.getJson<T>(`/attestations${formatQuery(params)}`)
  }

  /**
   * Fetch a single attestation by id.
   *
   * `id` accepts the bech32m `lat1...` form (canonical) or 64-char hex.
   */
  async getAttestation<T = unknown>(id: string): Promise<T> {
    return this.getJson<T>(`/attestations/${id}`)
  }

  /**
   * Page through the attestations recorded against a single schema.
   *
   * `schemaId` accepts the bech32m `lsc1...` form (canonical) or
   * 64-char hex (same encoding as [`getSchema`]).
   */
  async listAttestationsBySchema<T = unknown>(
    schemaId: string,
    params: { limit?: number; before?: string } = {},
  ): Promise<T> {
    return this.getJson<T>(`/schemas/${schemaId}/attestations${formatQuery(params)}`)
  }

  /**
   * Page through the attestations a single attestor has signed.
   *
   * `pubkey` accepts the bech32m `lpk1...` form (canonical) or 64-char
   * hex (the attestor public-key encoding the write side uses in
   * [`signRegisterAttestorSet`]).
   */
  async listAttestationsByAttestor<T = unknown>(
    pubkey: string,
    params: { limit?: number; before?: string } = {},
  ): Promise<T> {
    return this.getJson<T>(`/attestors/${pubkey}/attestations${formatQuery(params)}`)
  }

  /**
   * Page through the indexer's bounties list.
   *
   * Talks to ligate-api's `GET /v1/bounties`. Response shape is
   * `{ data: [...], pagination: { next, limit } }`. `status` filters by
   * lifecycle state (`open` / `exhausted` / `expired` / `cancelled` /
   * `finalised`) when the indexer supports it.
   */
  async listBounties<T = unknown>(
    params: { limit?: number; before?: string; status?: string } = {},
  ): Promise<T> {
    return this.getJson<T>(`/bounties${formatQuery(params)}`)
  }

  /**
   * Fetch a single bounty by id.
   *
   * `id` accepts the bech32m `lbt1...` form (canonical) or 64-char hex.
   */
  async getBounty<T = unknown>(id: string): Promise<T> {
    return this.getJson<T>(`/bounties/${id}`)
  }

  /**
   * Page through the indexer's contracts list.
   *
   * Talks to ligate-api's `GET /v1/contracts`. Response shape is
   * `{ data: [...], pagination: { next, limit } }`. `status` filters by
   * lifecycle state when the indexer supports it.
   */
  async listContracts<T = unknown>(
    params: { limit?: number; before?: string; status?: string } = {},
  ): Promise<T> {
    return this.getJson<T>(`/contracts${formatQuery(params)}`)
  }

  /**
   * Fetch a single contract by id.
   *
   * `id` accepts the bech32m `lct1...` form (canonical) or 64-char hex.
   */
  async getContract<T = unknown>(id: string): Promise<T> {
    return this.getJson<T>(`/contracts/${id}`)
  }

  // ---- Low-level escape hatches --------------------------------------------

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
 * Format a `?key=value&key=value` query string from a sparse object.
 * Skips `undefined` / `null` entries; returns `''` if no params.
 */
function formatQuery(params: Record<string, unknown>): string {
  const pairs: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`
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
