# Changelog

All notable changes to `@ligate-labs/sdk` ship here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-`0.1.0` releases may break wire format between minor versions; pin
the exact version if you depend on byte-level stability.

The release workflow (`.github/workflows/release.yml`) extracts the
matching version section from this file and uses it as the GitHub
Release body. Keep section headings in the format `## [X.Y.Z] - YYYY-MM-DD`.

## [Unreleased]

## [0.0.2] - 2026-05-09

### Added

- High-level attestation submit helpers: `submitRegisterAttestorSet`,
  `submitRegisterSchema`, `submitAttestation`. Mirror the
  build-sign-submit-wait shape of `submitTransfer`.
- `LigateClient` indexer query methods backed by ligate-api:
  `listBlocks`, `getBlock`, `listTxs`, `getTx`, `getAddressSummary`,
  `listSchemas`, `getSchema`, `getAttestorSet`. Each method takes an
  optional generic response type so callers can narrow once
  ligate-api's response shapes stabilise (tracked at
  [`ligate-api#1`](https://github.com/ligate-io/ligate-api/issues/1)).
- Browser-bundle smoke job in CI: bundles the SDK with esbuild's
  `--platform=browser` target. Catches regressions when a Node-only
  import (`node:`-prefixed module, etc.) sneaks into the public
  surface. Runs in <100ms; no DOM emulation needed since the SDK
  doesn't touch DOM APIs and `@noble/*` + `@scure/base` advertise
  browser-safety.
- This `CHANGELOG.md`. The release workflow extracts the matching
  section as the GitHub Release body instead of generating a
  one-liner.

### Fixed

- README `chainId` example referenced stale value `4321n`. Corrected
  to `4242n` (matches `ligate-chain/constants.toml`'s `CHAIN_ID`).

## [0.0.1] - 2026-05-08

### Added

- First stable release. Wire format pinned against `ligate-localnet-1`.
- Build / sign / submit transfer transactions
  (`signTransfer`, `submitTransfer`, `submitRawTx`).
- `LigateClient` with chain-direct query methods: `getRollupInfo`,
  `getNonce`, `getBalance`. Idempotent `/v1` URL prefix handling.
- Attestation runtime-call builders:
  `signRegisterAttestorSet`, `signRegisterSchema`, `signSubmitAttestation`.
  Deterministic id derivations: `deriveAttestorSetId`, `deriveSchemaId`.
- Bech32m id encoding for the four attestation HRPs (`las`, `lsc`,
  `lph`, `lpk`) and the bank token id (`token_`).
- Ed25519 keypair helpers (`generateKeypair`, `keypairFromPrivateKey`)
  using `@noble/ed25519` — no Buffer, no Node-only deps. Browser-safe.
- HTTP polling for tx inclusion via `waitForInclusion`.
- E2E test suite (`pnpm test:e2e`) that runs against a live localnet.
  CI runs unit tests only (e2e is opt-in).

### Wire-format anchors

- `Transaction::V0(Version0)` envelope (1 + 64 + 32 = 97 byte header).
- Address derivation: `pubkey[..28]` (28 raw bytes), bech32m-encoded
  with `lig` HRP. Not `SHA-256(pubkey)[..28]`.
- Sequencer accepts `{"body": base64(borsh(signed_tx))}`. Do not
  pre-wrap in `AuthenticatorInput::Standard(...)` — the chain wraps
  server-side and pre-wrapping double-wraps.
- Nonce lookup hits `/v1/rollup/addresses/{credential_id}/dedup`,
  returns `{"nonce": <u64>}`. Returns `0` for never-seen addresses.

## [0.0.1-rc.1] - 2026-05-08

### Added

- First release candidate. Smoke-tested the npm publish pipeline
  (sigstore provenance, granular token, scoped publish to
  `@ligate-labs`). Functionally identical to `0.0.1`.
