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

### Changed

- **Renamed token symbol `LGT` → `AVOW` everywhere.** Tracks [`ligate-chain#457`](https://github.com/ligate-io/ligate-chain/issues/457) and aligns with [chain v0.3.0](https://github.com/ligate-io/ligate-chain/releases/tag/v0.3.0). Substitutions cover prose, doc comments, example code, README quickstart, and internal helpers. `$` prefix dropped per the cleaner convention adopted chain-side. **Breaking on the wire**: requires the api side to ship its rename first. Holds for the same cutover window as chain v0.3.0 → devnet-2 boot + [ligate-api#70](https://github.com/ligate-io/ligate-api/pull/70).

## [0.1.1-devnet] - 2026-05-16

Attestor-side helpers + repo hygiene. Adds the attestor half of the attestation flow that was missing in `0.1.0-devnet`: anyone building a quorum signer in TypeScript (Mneme, third-party attestor services, custodial wallets adding attestation flows) can now compute the canonical digest, sign it, and derive `lpk1...` pubkeys without rolling their own ed25519+borsh+sha256.

Install: `npm install @ligate-labs/sdk@0.1.1-devnet` (or `@rc` for the devnet rc dist-tag).

### Added

- `attestationDigest({ schemaId, payloadHash, submitter, timestamp })`. Computes the canonical `SHA-256(borsh(SignedAttestationPayload))` digest the chain re-derives at submission time. Handles the `MultiAddress::Standard` 0x00 discriminator correctly (the most common drift point between off-chain signers and the on-chain verifier). (#31)
- `signAttestation({ privateKey, ...digestParams })`. Convenience wrapper: builds the digest, signs with ed25519, returns an `AttestorSignature` shaped for `signSubmitAttestation.signatures`. The full attestor → submitter pipeline now reads as: attestors run `signAttestation` and ship the signature; submitter aggregates and runs `signSubmitAttestation`. (#31)
- `pubkeyBech32FromPrivateKey(privateKey)`. Derives the `lpk1...` bech32m public key from a 32-byte ed25519 seed. This is the form `register-attestor-set --members` expects, so attestor onboarding no longer requires hand-rolling the bech32m encoding. Matches the new `ligate keys show --pubkey` flag in `ligate-cli` `v0.1.2-devnet`. (#31)
- Cross-impl parity test asserting on the canonical LIP-5 test vector from `docs/protocol/attestation-v0.md` §wire-format. Same vector is baked into the Rust `ligate-client` `attestation_digest` doctest in `ligate-chain` #351, so any drift between the two SDKs breaks CI on whichever side drifted. (#31)
- `.pre-commit-config.yaml` running prettier locally at commit time. Matches the chain repo + api repo patterns. (#32)

### Changed

- `AttestationDigestParams` and `SignAttestationParams` exported from the package barrel (`src/index.ts`). Callers can `import type` without reaching into the internal module path. (#31)

## [0.1.0-devnet] - 2026-05-15

First devnet-aligned release. Cut alongside `ligate-chain` `v0.1.0-devnet`, `ligate-cli` `v0.1.0-devnet`, and the `ligate-devnet-1` public rung. Ships under the `rc` npm dist-tag; `latest` stays on `0.0.2` until the wire format locks and a clean `0.1.0` (no suffix) lands.

Install: `npm install @ligate-labs/sdk@rc` (or pin: `@0.1.0-devnet`).

### Added

- `LigateClient` attestation read methods backed by ligate-api: `getSchema`, `getAttestorSet`, `getAttestation`. Pair with the existing `listSchemas` to give SDK consumers a full read-path through the Themisra schema-registry / attestor-set / attestation modules without dropping to raw `fetch`. (#27)
- Runnable example scripts in `examples/`: `generate-keypair.ts`, `transfer.ts`, `watch-balance.ts`. Each takes `--help`, reads `LIGATE_RPC` / `LIGATE_CHAIN_ID` / `LIGATE_TOKEN_ID` env vars (defaults match the localnet bring-up), and serves as copy-pasteable starter code for partner integrations. (#21)
- Playwright browser test matrix (Chromium, Firefox, WebKit). The matrix bundles the SDK with esbuild via a `globalSetup`, then exercises key generation, address derivation, and transaction signing in a real engine. Catches "the bundle emits but doesn't actually run in browser" regressions that the existing `bundle:browser-check` smoke can't catch. (#21)
- TypeDoc API reference build (`pnpm run docs`). CI uploads the result as a `typedoc-html` workflow artifact with 14-day retention. Public hosting on `docs.ligate.io/sdk` pending the subdomain routing decision. (#22)
- Bundle size gate (`pnpm size` via `size-limit`). CI fails if the published bundle exceeds the agreed budget. Stops "we accidentally pulled in a node-only dep that 10x'd the bundle" regressions before they reach users. (#22)
- E2E byte-level parity test vs `ligate-cli`. Generates the same transfer in both SDKs (TS + Rust) and asserts byte-identical `Transaction::V0` bytes pre-submit. Pins the borsh layout across both languages so a chain wire-format change can't silently desync the two SDKs. (#25)

### Changed

- bech32m parity across the signing path. Docs, signing internals, and tests updated to accept the `lig1` / `lsc1` / `las1` / `lph1` / `lpk1` HRPs and the `token_1...` token-id form introduced by `ligate-chain` commit `0ac7e5b`. Realigns the SDK with the chain's bech32m rewrite. (#20)

### Chore

- CLA Assistant Lite workflow + canonical `CLA.md` (mirrors `ligate-chain#257`). `sstefdev` allowlisted as an org member rather than a contributor. (#23, #24)
- `.github/workflows/release.yml` header comment updated: tagging convention now reads `v0.1.0-devnet` for the devnet rung (paired with `ligate-chain` `v0.1.0-devnet`), with `v0.1.0` (no suffix) reserved for the post-soak wire-format-stable cut. The previously documented `v0.0.1` at-devnet target predated the chain's tag consolidation.

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
