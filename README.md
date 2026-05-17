# ligate-js

[![CI](https://github.com/ligate-io/ligate-js/actions/workflows/ci.yml/badge.svg)](https://github.com/ligate-io/ligate-js/actions/workflows/ci.yml) [![License: Apache-2.0 OR MIT](https://img.shields.io/badge/license-Apache--2.0_OR_MIT-blue.svg)](#license) [![Chain](https://img.shields.io/badge/chain-ligate--devnet--1-A7D28C.svg)](https://github.com/ligate-io/ligate-chain) [![Docs](https://img.shields.io/badge/docs-docs.ligate.io-A7D28C.svg)](https://docs.ligate.io) [![Devnet](https://img.shields.io/badge/status-devnet-A7D28C.svg)](#status)

TypeScript SDK for [Ligate Chain](https://github.com/ligate-io/ligate-chain). Build, sign, submit transactions; query state; manage keys. Browser and Node compatible. Zero-dep on `Buffer`.

## Quick start

### Install

```bash
pnpm add @ligate-labs/sdk
# or:
npm install @ligate-labs/sdk
# or:
yarn add @ligate-labs/sdk
```

Latest published version: `0.2.0` (the `latest` dist-tag), wire-compatible with `ligate-chain` v0.2.0 (lat1 `AttestationId`). Pin to `^0.2.0` for minor-bump compatibility. The historical `rc` dist-tag points at `0.1.1-devnet`, which is pre-lat1 and wire-incompatible with current devnet; avoid pinning to `@rc`. Local checkouts work via `pnpm add file:../ligate-js` if you're contributing.

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
  chainId: 4242n, // from chain `constants.toml` (`CHAIN_ID`)
  chainHash: info.chain_hash,
})

console.log('tx hash:', result.txHash)
console.log('included on chain:', result.included)
```

The `/v1` prefix on the RPC URL is auto-appended idempotently, so `http://host:port`, `http://host:port/`, and `http://host:port/v1` all work the same way. Mirrors the cli (`GlobalArgs::rpc_with_v1`) and ligate-api (`Signer::new_with_chain_seed`) so all three SDKs normalize the same way.

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
  chainId: 4242n,
  chainHash: '<64-char hex>',
})

// Step 2: submit. `waitForInclusion: false` returns the moment the
// sequencer accepts the bytes, no polling.
const { txHash } = await submitRawTx(client, bytes, { waitForInclusion: false })

// Step 3: poll for inclusion separately, with whatever cadence and
// timeout the consumer wants.
await waitForInclusion(client, txHash, { pollIntervalMs: 1000, timeoutMs: 60_000 })
```

## API reference

Per-symbol reference (every exported function, type, and constant) is generated from the inline JSDoc via TypeDoc.

```bash
pnpm run docs   # writes static HTML to docs/
```

CI also builds it on every push and uploads the result as a `typedoc-html` workflow artifact (retention 14 days). Public hosting on `docs.ligate.io/sdk` is pending the subdomain routing decision; until that lands, grab the artifact from a recent CI run.

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
pnpm size                   # size-limit bundle budget check
pnpm run docs               # generate TypeDoc HTML in docs/
```

### Pre-commit hooks

`.pre-commit-config.yaml` runs `prettier --check` on every commit so formatting drift is caught locally instead of in CI. One-time setup per clone:

```bash
brew install pre-commit         # or: pip install pre-commit
pre-commit install              # writes .git/hooks/pre-commit
```

Skip the hook for an emergency commit with `git commit --no-verify`; the same check still re-runs in CI.

### Examples

Three runnable scripts in `examples/` demonstrate the public surface:

```bash
# Generate a fresh keypair and (optionally) write to a JSON file.
pnpm tsx examples/generate-keypair.ts
pnpm tsx examples/generate-keypair.ts --out my-key.json

# Build + sign + submit a 1 LGT transfer to a recipient. Uses the
# localnet dev key by default; pass --from to use a generated keypair.
# Requires a running localnet (see end-to-end section below).
pnpm tsx examples/transfer.ts \
    --to lig1u8z2rxh6ymjwkqsasme64f5kfphtfm2kf4kkn0clusfpr34amezsp5j7yp \
    --amount 1

# Poll an address's balance every N seconds (Ctrl-C to stop).
pnpm tsx examples/watch-balance.ts \
    lig1u8z2rxh6ymjwkqsasme64f5kfphtfm2kf4kkn0clusfpr34amezsp5j7yp \
    --interval 5
```

Each example reads `LIGATE_RPC`, `LIGATE_CHAIN_ID`, and `LIGATE_TOKEN_ID` env vars; defaults match the localnet bring-up in `ligate-chain/devnet/`. Run any example with `--help` for the full flag list.

### Browser test matrix

CI runs Playwright against Chromium, Firefox, and WebKit to prove the SDK actually works in a real browser engine (not just that the bundle emits — that's `bundle:browser-check`). Tests live in `tests/browser/`; the smoke spec navigates to a static HTML page that loads the bundled SDK via `<script type="module">` and exercises key generation, address derivation, and transaction signing.

```bash
# Local run (downloads browsers on first run):
pnpm exec playwright install
pnpm test:browser
```

The Playwright `globalSetup` (`tests/browser/global-setup.ts`) bundles the SDK with esbuild before any spec runs, so the bundle is always fresh.

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

**Devnet.** `ligate-devnet-1` is live.

Latest release: [`v0.2.0`](https://github.com/ligate-io/ligate-js/releases/tag/v0.2.0), published to npm as `@ligate-labs/sdk@0.2.0` (the `latest` dist-tag), wire-compatible with `ligate-chain` v0.2.0.

### Versioning

Plain semver, no network-name suffix on the package version. Per the convention in [`ligate-chain#374`](https://github.com/ligate-io/ligate-chain/pull/374), network identity lives in `chain_id` (`ligate-devnet-1`, future `ligate-testnet-1` / `ligate-mainnet-1`), not in the package version. Past `-devnet` tags (`v0.1.0-devnet`, `v0.1.1-devnet`) stay as archaeology.

Pre-1.0 (`v0.x.y`) is "may break in minor versions". v0.2.0 in particular collapsed `AttestationId` from compound `<schema_id>:<payload_hash>` to single bech32m `lat1...`; consumers pinning `^0.1.0` will NOT auto-upgrade to v0.2.0 and need to bump intentionally. After v1.0, minor bumps are guaranteed wire-compatible.

## Related repos

- [`ligate-chain`](https://github.com/ligate-io/ligate-chain) — Sovereign SDK rollup, the chain itself
- [`ligate-cli`](https://github.com/ligate-io/ligate-cli) — Rust operator and builder cli (sister tool to this SDK)
- [`faucet`](https://github.com/ligate-io/faucet) — public devnet drip service
- [`explorer`](https://github.com/ligate-io/explorer) — block / tx browser

## License

Dual-licensed under [Apache 2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT) at your option.
