# ligate-js

[![CI](https://github.com/ligate-io/ligate-js/actions/workflows/ci.yml/badge.svg)](https://github.com/ligate-io/ligate-js/actions/workflows/ci.yml) [![License: Apache-2.0 OR MIT](https://img.shields.io/badge/license-Apache--2.0_OR_MIT-blue.svg)](#license) [![Chain](https://img.shields.io/badge/chain-ligate--devnet--1-A7D28C.svg)](https://github.com/ligate-io/ligate-chain) [![Docs](https://img.shields.io/badge/docs-docs.ligate.io-A7D28C.svg)](https://docs.ligate.io) [![Pre-devnet](https://img.shields.io/badge/status-pre--devnet-E8833A.svg)](#status)

TypeScript SDK for [Ligate Chain](https://github.com/ligate-io/ligate-chain). Build, sign, submit transactions; query state; manage keys. Browser and Node compatible. Zero-dep on `Buffer`.

## Quick start

### Install

```bash
pnpm add @ligate-labs/sdk
# or: npm install @ligate-labs/sdk
# or: yarn add @ligate-labs/sdk
```

Once published. Until then, the package is installable from the GitHub URL.

### Use

```ts
import { generateKeypair, LigateClient, submitTransfer } from '@ligate-labs/sdk'

// Generate or load a key.
const sender = generateKeypair()
console.log('address:', sender.address)

// Connect to a Ligate node. The `/v1` URL prefix is added automatically.
const rpcUrl = 'http://localhost:12346'
const client = new LigateClient({ rpcUrl })

// Pull chain identity + the sender's next nonce.
const info = await client.getRollupInfo()
const nonce = await client.getNonce(sender.publicKey)

// Build, sign, submit, wait for inclusion — one call.
const result = await submitTransfer({
  rpcUrl,
  privateKey: sender.privateKeyHex,
  publicKey: sender.publicKey,
  to: 'lig1xyz...',
  amountNano: 1_000_000_000n, // 1 LGT
  // tokenId accepts hex, Uint8Array, or `token_1...` bech32m form;
  // both signing and getBalance normalise internally.
  tokenId: 'token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7',
  nonce,
  chainId: 4321n, // from chain `chain_state.json`
  chainHash: info.chain_hash,
})

console.log('tx hash:', result.txHash)
console.log('included on chain:', result.included)
```

The `/v1` prefix on the RPC URL is auto-appended idempotently, so `http://host:port`, `http://host:port/`, and `http://host:port/v1` all work the same way. Mirrors the cli (`GlobalArgs::rpc_with_v1`) and faucet (`Signer::new`) so all three SDKs normalize the same way.

## Lower-level API

When the bundled `submitTransfer` doesn't fit (custom polling, batch builds, signing offline) compose the primitives directly:

```ts
import {
  signTransfer,
  submitRawTx,
  waitForInclusion,
  LigateClient,
  keypairFromPrivateKey,
} from '@ligate-labs/sdk'

const client = new LigateClient({ rpcUrl: 'http://localhost:12346' })
const sender = keypairFromPrivateKey(process.env.LIGATE_KEY!)
const nonce = await client.getNonce(sender.publicKey)

// Step 1: build + sign offline. Returns borsh-encoded `Transaction::V0`
// bytes ready to send to `POST /v1/sequencer/txs`. Pure CPU, no network.
const bytes = signTransfer({
  privateKey: sender.privateKeyHex,
  publicKey: sender.publicKey,
  to: 'lig1xyz...',
  amountNano: 1_000_000_000n,
  tokenId: '<64-char hex>',
  nonce,
  chainId: 4321n,
  chainHash: '<64-char hex>',
})

// Step 2: submit. `waitForInclusion: false` returns the moment the
// sequencer accepts the bytes, no polling.
const { txHash } = await submitRawTx(client, bytes, { waitForInclusion: false })

// Step 3: poll for inclusion separately, with whatever cadence and
// timeout the consumer wants.
await waitForInclusion(client, txHash, { pollIntervalMs: 1000, timeoutMs: 60_000 })
```

## Wire-format gotchas (so you don't hit them)

The SDK takes care of these, but they're worth knowing if you're debugging or extending it:

- **Don't pre-wrap.** `signTransfer` returns `borsh(Transaction::V0(Version0))`. The chain's `POST /v1/sequencer/txs` handler wraps in `AuthenticatorInput::Standard(...)` server-side. Pre-wrapping double-wraps and the chain rejects with `Cannot decompress Edwards point`. (See [`ligate-chain#245`](https://github.com/ligate-io/ligate-chain/issues/245).)
- **Address derivation is `pubkey[..28]`.** First 28 bytes of the 32-byte Ed25519 pubkey, bech32m-encoded with the `lig` HRP. NOT `SHA-256(pubkey)[..28]` — that's how genesis-stub addresses are derived from string labels (and using it for keypair-derived addresses produces `CannotReserveGas("Insufficient balance")` on submit).
- **Confirmation is HTTP polling, not WebSocket.** `waitForInclusion` polls `GET /v1/ledger/txs/{hash}` every 500ms. The Sovereign SDK's `wait_for_tx_processing` uses a WebSocket subscription that hits a URL-parsing bug (`invalid port value`) on non-standard ports. (See [`ligate-cli#8`](https://github.com/ligate-io/ligate-cli/issues/8).)
- **Signature is over `borsh(UnsignedTransaction) ++ chain_hash`.** The 32-byte chain hash binds signatures to the runtime version; it comes from `GET /v1/rollup/info`. Without the hash, a signature for `ligate-localnet-1` would also work on `ligate-devnet-1`, which the chain explicitly prevents.

## Compatibility

- **Node**: 20+ (uses global `fetch`, `crypto.getRandomValues`, native `BigInt`).
- **Browsers**: any with `fetch` and `crypto.getRandomValues` (all modern). The SDK avoids `Buffer` so it bundles cleanly without polyfills.
- **Edge runtimes**: Cloudflare Workers, Vercel Edge, Deno — all fine, same constraints as browsers.

## Development

```bash
pnpm install                # install dependencies
pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run (unit suite only, ~400ms)
pnpm test:watch             # vitest watch mode
pnpm test:e2e               # vitest e2e (REQUIRES a running localnet — see below)
pnpm fmt                    # prettier --write
pnpm fmt:check              # prettier --check (CI gate)
pnpm build                  # compile to dist/ for publish
```

### End-to-end test against a running localnet

`e2e/` is the canary for wire-format drift between the TS SDK and the Rust chain. Stubbed-fetch unit tests pin URL shapes + discriminants, but only running against a real chain catches a borsh field-order mismatch.

```bash
# Boot a localnet from the chain repo (separate terminal):
cd ~/Desktop/ligate-chain
cargo run --bin ligate-node

# Then in this repo:
pnpm test:e2e
```

The suite reads chain config from env (`LIGATE_E2E_RPC`, `LIGATE_E2E_CHAIN_ID`, `LIGATE_E2E_TOKEN_ID`); defaults match the chain's localnet config out-of-the-box. If the RPC isn't reachable, every e2e test SKIPS with a clear "boot a localnet first" message rather than failing.

CI runs the unit suite (`pnpm test`) on every PR but does NOT run e2e — opt-in via `pnpm test:e2e` locally before tagging a release.

The chain-side test vector is the localnet dev key (`devnet/local-dev-key.json`, [`ligate-chain#247`](https://github.com/ligate-io/ligate-chain/pull/247)) — private key `0x01...01`, address `lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u`. Pinned in `test/keys.test.ts`. If chain regenerates the dev key, those tests need the new vectors.

## Status

**Pre-devnet.** `ligate-devnet-1` is targeted for **Q2 2026**. Tracking issue: [`ligate-chain#112`](https://github.com/ligate-io/ligate-chain/issues/112).

Versioning: `0.0.x` while the chain's wire format is still settling. We'll cut `0.1.0` once the chain enters public devnet (Q2 2026) and the surface stops moving day-to-day.

## Related repos

- [`ligate-chain`](https://github.com/ligate-io/ligate-chain) — Sovereign SDK rollup, the chain itself
- [`ligate-cli`](https://github.com/ligate-io/ligate-cli) — Rust operator and builder cli (sister tool to this SDK)
- [`faucet`](https://github.com/ligate-io/faucet) — public devnet drip service
- [`explorer`](https://github.com/ligate-io/explorer) — block / tx browser

## License

Dual-licensed under [Apache 2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT) at your option.
