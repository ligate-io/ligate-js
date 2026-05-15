/**
 * Attestation runtime-call builders.
 *
 * The chain's `attestation` module ships three user-callable
 * variants of `CallMessage`:
 *
 * - `RegisterAttestorSet { members, threshold }` — register an
 *   M-of-N quorum of ed25519 pubkeys
 * - `RegisterSchema { name, version, attestor_set, fee_routing_bps,
 *   fee_routing_addr, payload_shape_hash }` — register a schema
 *   bound to an existing attestor set
 * - `SubmitAttestation { schema_id, payload_hash, signatures }` —
 *   submit an attestation: a `(payload_hash)` for an existing
 *   `(schema_id)`, signed by ≥ threshold of the schema's attestor
 *   set
 *
 * This module exports one `sign*` function per variant, plus the
 * deterministic id derivations (`deriveAttestorSetId`,
 * `deriveSchemaId`) so consumers can compute ids offline without
 * round-tripping the chain.
 *
 * ## Wire format anchors
 *
 * The borsh layout is pinned by the Rust-side fixture probe at
 * `ligate-chain/crates/bootstrap-cli/examples/disc_probe.rs`. The
 * test file `test/attestation.test.ts` re-encodes the same fixtures
 * in TS and asserts byte equality; if a future Sovereign SDK pin
 * shifts the runtime composition or the field order, that test
 * breaks loudly here rather than silently producing
 * chain-rejected txs.
 *
 * RuntimeCall::Attestation = 0x09 (9th module in the runtime
 * declaration order — see `ligate-stf-declaration::Runtime`).
 *
 * ## Bech32m id types
 *
 * The chain uses four bech32m HRPs for attestation-related ids:
 *
 * | Type | HRP | Example |
 * |---|---|---|
 * | `AttestorSetId` | `las` | `las1g26ad...` |
 * | `SchemaId` | `lsc` | `lsc1lwcuml...` |
 * | `PayloadHash` | `lph` | `lph1...` |
 * | `PubKey` | `lpk` | `lpk1...` |
 *
 * Each is 32 bytes underneath; the bech32m encoding lives in this
 * module so consumers only deal with the typed string forms.
 */

import { bech32m } from '@scure/base'
import { sha256 } from '@noble/hashes/sha256'

import { decodeAddress } from './address.js'
import { BorshWriter } from './borsh.js'
import { bytesToHex, hexToBytes, keypairFromPrivateKey, sign as signMessage } from './keys.js'
import { wrapAndSign } from './transaction.js'
import type { SignEnvelopeParams } from './transaction.js'

// ---- Discriminants ---------------------------------------------------------

/**
 * Outer discriminant for `RuntimeCall::Attestation(...)`.
 *
 * 9th module in the runtime declaration order (bank, accounts,
 * sequencer_registry, operator_incentives, attester_incentives,
 * prover_incentives, uniqueness, chain_state, blob_storage,
 * **attestation**). Captured by the chain-side probe at
 * `bootstrap-cli/examples/disc_probe.rs`.
 */
export const RUNTIME_ATTESTATION_DISC = 0x09

/** Inner: `CallMessage::RegisterAttestorSet`. */
export const REGISTER_ATTESTOR_SET_DISC = 0x00

/** Inner: `CallMessage::RegisterSchema`. */
export const REGISTER_SCHEMA_DISC = 0x01

/** Inner: `CallMessage::SubmitAttestation`. */
export const SUBMIT_ATTESTATION_DISC = 0x02

/** `MultiAddress::Standard(Address)` discriminant for `S::Address`. */
const ADDR_STANDARD_DISC = 0x00

// ---- HRPs + length constants -----------------------------------------------

/** HRP for `AttestorSetId` bech32m strings (`las1...`). */
export const ATTESTOR_SET_HRP = 'las'
/** HRP for `SchemaId` bech32m strings (`lsc1...`). */
export const SCHEMA_HRP = 'lsc'
/** HRP for `PayloadHash` bech32m strings (`lph1...`). */
export const PAYLOAD_HASH_HRP = 'lph'
/** HRP for `PubKey` bech32m strings (`lpk1...`). */
export const PUBKEY_HRP = 'lpk'

/** All attestation ids are 32 bytes underneath. */
export const ATTESTATION_ID_BYTE_LENGTH = 32

/** Hard cap on attestor-set members (per `attestation::MAX_ATTESTOR_SET_MEMBERS`). */
export const MAX_ATTESTOR_SET_MEMBERS = 64

/** Same as members cap (one signature per member). */
export const MAX_ATTESTATION_SIGNATURES = MAX_ATTESTOR_SET_MEMBERS

/** Per-signature byte cap (per `attestation::MAX_ATTESTOR_SIGNATURE_BYTES`). */
export const MAX_ATTESTOR_SIGNATURE_BYTES = 128

// ---- Bech32m encode/decode helpers -----------------------------------------

function encodeId(hrp: string, bytes: Uint8Array): string {
  if (bytes.length !== ATTESTATION_ID_BYTE_LENGTH) {
    throw new Error(`expected ${ATTESTATION_ID_BYTE_LENGTH}-byte id, got ${bytes.length}`)
  }
  return bech32m.encode(hrp, bech32m.toWords(bytes))
}

function decodeId(hrp: string, s: string): Uint8Array {
  const decoded = bech32m.decode(s as `${string}1${string}`)
  if (decoded.prefix !== hrp) {
    throw new Error(`expected '${hrp}' bech32m prefix, got '${decoded.prefix}' in ${s}`)
  }
  const bytes = bech32m.fromWords(decoded.words)
  if (bytes.length !== ATTESTATION_ID_BYTE_LENGTH) {
    throw new Error(
      `expected ${ATTESTATION_ID_BYTE_LENGTH}-byte id payload, got ${bytes.length} in ${s}`,
    )
  }
  return Uint8Array.from(bytes)
}

/** Encode 32 raw bytes as `las1...`. */
export function encodeAttestorSetId(bytes: Uint8Array): string {
  return encodeId(ATTESTOR_SET_HRP, bytes)
}

/** Decode `las1...` to 32 raw bytes. */
export function decodeAttestorSetId(s: string): Uint8Array {
  return decodeId(ATTESTOR_SET_HRP, s)
}

/** Encode 32 raw bytes as `lsc1...`. */
export function encodeSchemaId(bytes: Uint8Array): string {
  return encodeId(SCHEMA_HRP, bytes)
}

/** Decode `lsc1...` to 32 raw bytes. */
export function decodeSchemaId(s: string): Uint8Array {
  return decodeId(SCHEMA_HRP, s)
}

/** Encode 32 raw bytes as `lph1...`. */
export function encodePayloadHash(bytes: Uint8Array): string {
  return encodeId(PAYLOAD_HASH_HRP, bytes)
}

/** Decode `lph1...` to 32 raw bytes. */
export function decodePayloadHash(s: string): Uint8Array {
  return decodeId(PAYLOAD_HASH_HRP, s)
}

/** Encode a 32-byte ed25519 pubkey as `lpk1...`. */
export function encodePubKey(bytes: Uint8Array): string {
  return encodeId(PUBKEY_HRP, bytes)
}

/** Decode `lpk1...` to 32 raw bytes. */
export function decodePubKey(s: string): Uint8Array {
  return decodeId(PUBKEY_HRP, s)
}

/**
 * Coerce one of the 32-byte id types into raw bytes.
 *
 * Accepts:
 * - `Uint8Array` of length 32
 * - 64-char hex string (with or without `0x` prefix)
 * - bech32m string with the matching HRP
 *
 * Used internally by `sign*` builders so callers can pass any of
 * the three forms.
 */
function idToBytes(value: string | Uint8Array, hrp: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== ATTESTATION_ID_BYTE_LENGTH) {
      throw new Error(`expected ${ATTESTATION_ID_BYTE_LENGTH}-byte id, got ${value.length}`)
    }
    return value
  }
  if (typeof value === 'string' && value.startsWith(`${hrp}1`)) {
    return decodeId(hrp, value)
  }
  // Assume hex.
  const bytes = hexToBytes(value as string)
  if (bytes.length !== ATTESTATION_ID_BYTE_LENGTH) {
    throw new Error(`expected ${ATTESTATION_ID_BYTE_LENGTH}-byte id from hex, got ${bytes.length}`)
  }
  return bytes
}

// ---- Deterministic id derivations ------------------------------------------

/**
 * Derive an `AttestorSetId` from members + threshold.
 *
 * Mirrors `attestation::AttestorSet::derive_id`:
 *
 * 1. Sort `members` by raw byte representation (the chain-side does
 *    `sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()))`).
 * 2. SHA-256(`sorted_members_concatenated || threshold_u8`).
 *
 * Returns the 32-byte id. Use [`encodeAttestorSetId`] to get the
 * `las1...` string form.
 */
export function deriveAttestorSetId(members: Uint8Array[], threshold: number): Uint8Array {
  for (const m of members) {
    if (m.length !== 32) {
      throw new Error(`each attestor member must be 32 bytes; got ${m.length}`)
    }
  }
  if (threshold < 0 || threshold > 0xff) {
    throw new Error(`threshold out of u8 range: ${threshold}`)
  }
  // Sort by raw byte order (Rust `Ord` for `[u8]` is lexicographic).
  const sorted = [...members].sort(compareBytes)
  const hasher = sha256.create()
  for (const m of sorted) {
    hasher.update(m)
  }
  hasher.update(new Uint8Array([threshold & 0xff]))
  return hasher.digest()
}

/**
 * Derive a `SchemaId` from owner address + name + version.
 *
 * Mirrors `attestation::Schema::derive_id`:
 *
 * `SHA-256(owner.as_ref() || name.as_bytes() || version.to_le_bytes())`.
 *
 * `owner.as_ref()` returns the chain's 28-byte address bytes (per
 * `MultiAddress<EthereumAddress>::as_ref`). [`addressBytesFromPubkey`]
 * or [`decodeAddress`] from `./address.ts` produces those bytes.
 */
export function deriveSchemaId(
  ownerAddrBytes: Uint8Array,
  name: string,
  version: number,
): Uint8Array {
  if (ownerAddrBytes.length !== 28) {
    throw new Error(`owner address must be 28 bytes, got ${ownerAddrBytes.length}`)
  }
  if (version < 0 || version > 0xffffffff) {
    throw new Error(`version out of u32 range: ${version}`)
  }
  const nameBytes = new TextEncoder().encode(name)
  const versionBytes = new Uint8Array(4)
  // u32 little-endian.
  new DataView(versionBytes.buffer).setUint32(0, version, true)
  const hasher = sha256.create()
  hasher.update(ownerAddrBytes)
  hasher.update(nameBytes)
  hasher.update(versionBytes)
  return hasher.digest()
}

// ---- Attestor-side signing -------------------------------------------------

/** Inputs to [`attestationDigest`] / [`signAttestation`]. */
export interface AttestationDigestParams {
  /**
   * Schema this attestation is under. Accepts 32-byte `Uint8Array`,
   * 64-char hex, or `lsc1...` bech32m.
   */
  schemaId: string | Uint8Array
  /**
   * Hash of the off-chain payload. Accepts 32-byte `Uint8Array`,
   * 64-char hex, or `lph1...` bech32m.
   */
  payloadHash: string | Uint8Array
  /**
   * Address that will submit the on-chain tx, NOT the attestor's
   * address. The chain re-derives the digest at submission time
   * using `context.sender()`, so the value here MUST match the
   * eventual submitter for the signature to verify. Accepts 28-byte
   * `Uint8Array` (raw `Address` bytes) or `lig1...` bech32m.
   */
  submitter: string | Uint8Array
  /**
   * Unix seconds the digest is computed against. Defaults to `0n`
   * because chain v0 hardcodes `timestamp = 0` in
   * `handle_submit_attestation` (the runtime doesn't yet expose
   * block headers). Override only if signing against a chain that
   * uses a different timestamp source.
   */
  timestamp?: bigint
}

/**
 * Compute the canonical attestation digest the chain re-derives at
 * submission time.
 *
 * Layout (Borsh, 101 bytes; see `docs/protocol/attestation-v0.md`
 * §wire-format for the byte-by-byte table):
 *
 * ```
 * schema_id    [u8; 32]
 * payload_hash [u8; 32]
 * 0x00         (MultiAddress::Standard discriminator)
 * submitter    [u8; 28]
 * timestamp    u64 little-endian
 * ```
 *
 * The discriminator byte is the most common stumble for hand-rolled
 * signers, because `S::Address` resolves to `MultiAddress<VmAddress>`
 * (an enum) and not the bare 28-byte `Address`. The chain's verifier
 * now surfaces the digest it computed in
 * `AttestationError::InvalidSignature` if your sig fails to verify,
 * so any mismatch is debuggable end-to-end without grepping crates.
 *
 * @returns the 32-byte SHA-256 digest.
 */
export function attestationDigest(params: AttestationDigestParams): Uint8Array {
  const schemaId = idToBytes(params.schemaId, SCHEMA_HRP)
  const payloadHash = idToBytes(params.payloadHash, PAYLOAD_HASH_HRP)
  const submitter =
    params.submitter instanceof Uint8Array
      ? params.submitter
      : decodeAddress(params.submitter)
  if (submitter.length !== 28) {
    throw new Error(`submitter address must be 28 bytes; got ${submitter.length}`)
  }
  const timestamp = params.timestamp ?? 0n

  const w = new BorshWriter()
  w.writeFixedBytes(schemaId, 32)
  w.writeFixedBytes(payloadHash, 32)
  // MultiAddress::Standard(Address) discriminator. Required; chain
  // verifier re-derives the same byte and any signer that omits it
  // computes a different digest, failing verification.
  w.writeU8(ADDR_STANDARD_DISC)
  w.writeFixedBytes(submitter, 28)
  w.writeU64(timestamp)

  return sha256.create().update(w.bytes()).digest()
}

/** Sign an [`attestationDigest`] with a 32-byte ed25519 private key. */
export interface SignAttestationParams extends AttestationDigestParams {
  /**
   * 32-byte ed25519 seed. Accepts `Uint8Array` or 64-char hex
   * (`0x`-prefix optional). Same form `keypairFromPrivateKey`
   * accepts.
   */
  privateKey: string | Uint8Array
}

/**
 * Compute the canonical attestation digest and sign it.
 *
 * Returns an [`AttestorSignature`] (pubkey + 64-byte ed25519 sig)
 * shaped for `signSubmitAttestation.signatures`. The natural M-of-N
 * flow is: each attestor runs `signAttestation(...)` on their own
 * machine, the submitter concatenates the returned signatures, and
 * the submitter calls `signSubmitAttestation` with the array.
 */
export function signAttestation(params: SignAttestationParams): AttestorSignature {
  const digest = attestationDigest(params)
  const sk = typeof params.privateKey === 'string' ? hexToBytes(params.privateKey) : params.privateKey
  if (sk.length !== 32) {
    throw new Error(`expected 32-byte private key, got ${sk.length} bytes`)
  }
  const { publicKey } = keypairFromPrivateKey(sk)
  const sig = signMessage(digest, sk)
  return { pubkey: publicKey, sig }
}

/**
 * Derive the bech32m `lpk1...` public key form from a 32-byte ed25519
 * private key. Convenience wrapper around `keypairFromPrivateKey`
 * for the common case of "I have an attestor's private key on disk
 * and want to tell the operator the lpk1 to feed into
 * `register-attestor-set --members`."
 */
export function pubkeyBech32FromPrivateKey(privateKey: string | Uint8Array): string {
  const sk = typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey
  if (sk.length !== 32) {
    throw new Error(`expected 32-byte private key, got ${sk.length} bytes`)
  }
  return encodePubKey(keypairFromPrivateKey(sk).publicKey)
}

// ---- Builders --------------------------------------------------------------

/** Inputs to [`signRegisterAttestorSet`]. */
export interface SignRegisterAttestorSetParams extends SignEnvelopeParams {
  /**
   * Attestor pubkeys, each 32 bytes. Borsh order is the order
   * passed here; the chain re-derives `attestor_set_id` after
   * sorting internally, so passing in any order produces the same
   * registered id (the bytes-on-the-wire differ but the id doesn't).
   */
  members: Uint8Array[]
  /** M-of-N threshold. Must be `>= 1` and `<= members.length`. */
  threshold: number
}

/**
 * Build, sign, and borsh-encode a `RegisterAttestorSet` transaction.
 *
 * The `attestor_set_id` the chain ends up storing can be computed
 * offline via [`deriveAttestorSetId`] before submission.
 */
export function signRegisterAttestorSet(params: SignRegisterAttestorSetParams): Uint8Array {
  if (params.members.length === 0) {
    throw new Error('members must not be empty')
  }
  if (params.members.length > MAX_ATTESTOR_SET_MEMBERS) {
    throw new Error(
      `members exceeds MAX_ATTESTOR_SET_MEMBERS (${MAX_ATTESTOR_SET_MEMBERS}); got ${params.members.length}`,
    )
  }
  if (params.threshold < 1 || params.threshold > params.members.length) {
    throw new Error(`threshold ${params.threshold} out of range [1, ${params.members.length}]`)
  }
  for (const m of params.members) {
    if (m.length !== 32) {
      throw new Error(`each member pubkey must be 32 bytes; got ${m.length}`)
    }
  }

  const w = new BorshWriter()
  w.writeU8(RUNTIME_ATTESTATION_DISC)
  w.writeU8(REGISTER_ATTESTOR_SET_DISC)
  // SafeVec<PubKey, _> = Vec<[u8;32]>: u32 LE len + N×32 bytes.
  w.writeU32(params.members.length)
  for (const m of params.members) {
    w.writeFixedBytes(m, 32)
  }
  w.writeU8(params.threshold & 0xff)
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to [`signRegisterSchema`]. */
export interface SignRegisterSchemaParams extends SignEnvelopeParams {
  /** Schema name (e.g. `themisra.proof-of-prompt`). UTF-8. */
  name: string
  /** Schema version, monotonic per name. */
  version: number
  /**
   * Attestor set id this schema binds to. Accepts `Uint8Array`,
   * 64-char hex, or `las1...` bech32m form.
   */
  attestorSetId: string | Uint8Array
  /**
   * Fee-routing share in basis points (1/10000). 0 = no routing.
   * Capped on-chain at `attestation::DEFAULT_MAX_BUILDER_BPS` (5000).
   */
  feeRoutingBps?: number
  /**
   * Fee-routing destination, `lig1...`. Required iff `feeRoutingBps > 0`.
   */
  feeRoutingAddr?: string
  /** SHA-256 of the canonical schema-doc bytes (32 bytes). */
  payloadShapeHash: string | Uint8Array
}

/**
 * Build, sign, and borsh-encode a `RegisterSchema` transaction.
 *
 * The resulting `schema_id` is `deriveSchemaId(signer_address_bytes,
 * name, version)`. Compute offline via [`deriveSchemaId`] +
 * [`addressBytesFromPubkey`] if you need it before submission.
 */
export function signRegisterSchema(params: SignRegisterSchemaParams): Uint8Array {
  const feeRoutingBps = params.feeRoutingBps ?? 0
  if (feeRoutingBps < 0 || feeRoutingBps > 0xffff) {
    throw new Error(`feeRoutingBps out of u16 range: ${feeRoutingBps}`)
  }
  if (feeRoutingBps > 0 && !params.feeRoutingAddr) {
    throw new Error('feeRoutingBps > 0 but feeRoutingAddr is unset')
  }
  if (feeRoutingBps === 0 && params.feeRoutingAddr) {
    throw new Error('feeRoutingAddr is set but feeRoutingBps is 0')
  }
  if (params.version < 0 || params.version > 0xffffffff) {
    throw new Error(`version out of u32 range: ${params.version}`)
  }

  const attestorSet = idToBytes(params.attestorSetId, ATTESTOR_SET_HRP)
  const payloadShapeHash =
    typeof params.payloadShapeHash === 'string' || params.payloadShapeHash instanceof Uint8Array
      ? params.payloadShapeHash instanceof Uint8Array
        ? params.payloadShapeHash
        : hexToBytes(params.payloadShapeHash)
      : (() => {
          throw new Error('payloadShapeHash must be string or Uint8Array')
        })()
  if (payloadShapeHash.length !== 32) {
    throw new Error(`payloadShapeHash must be 32 bytes, got ${payloadShapeHash.length}`)
  }

  const w = new BorshWriter()
  w.writeU8(RUNTIME_ATTESTATION_DISC)
  w.writeU8(REGISTER_SCHEMA_DISC)
  // SafeString name: u32 LE len + utf8.
  w.writeString(params.name)
  // version: u32 LE.
  w.writeU32(params.version)
  // attestor_set_id: 32 raw bytes.
  w.writeFixedBytes(attestorSet, 32)
  // fee_routing_bps: u16 LE.
  w.writeU16(feeRoutingBps)
  // fee_routing_addr: Option<S::Address> where Address = MultiAddress::Standard(28 bytes).
  if (params.feeRoutingAddr) {
    w.writeOptionTag(true)
    w.writeU8(ADDR_STANDARD_DISC)
    w.writeFixedBytes(decodeAddress(params.feeRoutingAddr), 28)
  } else {
    w.writeOptionTag(false)
  }
  // payload_shape_hash: 32 raw bytes.
  w.writeFixedBytes(payloadShapeHash, 32)
  return wrapAndSign(w.bytes(), params)
}

/** One off-chain attestor signature (for `signSubmitAttestation.signatures`). */
export interface AttestorSignature {
  /** Attestor pubkey, 32 bytes. */
  pubkey: Uint8Array
  /** Detached signature over the canonical attestation digest, ≤ 128 bytes. */
  sig: Uint8Array
}

/** Inputs to [`signSubmitAttestation`]. */
export interface SignSubmitAttestationParams extends SignEnvelopeParams {
  /**
   * Schema this attestation belongs to. Accepts `Uint8Array`,
   * 64-char hex, or `lsc1...` bech32m form.
   */
  schemaId: string | Uint8Array
  /**
   * Hash of the attestation payload (off-chain content). Accepts
   * `Uint8Array`, 64-char hex, or `lph1...` bech32m form.
   */
  payloadHash: string | Uint8Array
  /**
   * Attestor signatures collected off-chain. ≥ schema's threshold;
   * each entry's `pubkey` must be in the bound attestor set.
   */
  signatures: AttestorSignature[]
}

/**
 * Build, sign, and borsh-encode a `SubmitAttestation` transaction.
 *
 * The chain verifies that:
 *
 * 1. `schema_id` resolves to a registered schema.
 * 2. Every signature's `pubkey` is in the schema's attestor set.
 * 3. The number of valid signatures meets the schema's threshold.
 * 4. Each signature is a valid Ed25519 signature over the canonical
 *    `(schema_id, payload_hash, submitter_addr, timestamp)` digest.
 *
 * The off-chain quorum service (e.g. Themisra's) is responsible for
 * collecting the signatures; this builder just packages them for
 * on-chain submission.
 */
export function signSubmitAttestation(params: SignSubmitAttestationParams): Uint8Array {
  if (params.signatures.length === 0) {
    throw new Error('signatures must not be empty')
  }
  if (params.signatures.length > MAX_ATTESTATION_SIGNATURES) {
    throw new Error(
      `signatures exceeds MAX_ATTESTATION_SIGNATURES (${MAX_ATTESTATION_SIGNATURES}); got ${params.signatures.length}`,
    )
  }
  for (const s of params.signatures) {
    if (s.pubkey.length !== 32) {
      throw new Error(`each signature.pubkey must be 32 bytes; got ${s.pubkey.length}`)
    }
    if (s.sig.length === 0 || s.sig.length > MAX_ATTESTOR_SIGNATURE_BYTES) {
      throw new Error(
        `each signature.sig must be 1..=${MAX_ATTESTOR_SIGNATURE_BYTES} bytes; got ${s.sig.length}`,
      )
    }
  }
  const schemaId = idToBytes(params.schemaId, SCHEMA_HRP)
  const payloadHash = idToBytes(params.payloadHash, PAYLOAD_HASH_HRP)

  const w = new BorshWriter()
  w.writeU8(RUNTIME_ATTESTATION_DISC)
  w.writeU8(SUBMIT_ATTESTATION_DISC)
  w.writeFixedBytes(schemaId, 32)
  w.writeFixedBytes(payloadHash, 32)
  // SafeVec<AttestorSignature, _>: u32 LE len + N entries.
  w.writeU32(params.signatures.length)
  for (const s of params.signatures) {
    // AttestorSignature: pubkey [u8;32] + sig SafeVec<u8>.
    w.writeFixedBytes(s.pubkey, 32)
    w.writeVecU8(s.sig)
  }
  return wrapAndSign(w.bytes(), params)
}

// ---- Internal helpers ------------------------------------------------------

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0)
  }
  return a.length - b.length
}

/** Convenience: hex of any 32-byte id. */
export function attestationIdToHex(value: string | Uint8Array): string {
  if (value instanceof Uint8Array) return bytesToHex(value)
  // Try each HRP; if it matches one, decode + re-hex.
  for (const hrp of [ATTESTOR_SET_HRP, SCHEMA_HRP, PAYLOAD_HASH_HRP, PUBKEY_HRP]) {
    if (value.startsWith(`${hrp}1`)) {
      return bytesToHex(decodeId(hrp, value))
    }
  }
  // Fall back to assuming hex.
  return bytesToHex(hexToBytes(value))
}
