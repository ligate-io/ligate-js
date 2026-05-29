/**
 * Bounty marketplace runtime-call builders.
 *
 * The chain's `bounty` module ships six user-callable `CallMessage`
 * variants for the bounty lifecycle:
 *
 * - `PostBounty` post + escrow a buyer-funded bounty against a board schema
 * - `ClaimBounty` claim one or more attestations against an open bounty
 * - `DisputeAttestation` dispute a specific claim inside its window
 * - `ResolveDispute` resolve an open dispute (accept or reject)
 * - `CancelBounty` cancel an unfunded or expired bounty
 * - `FinaliseBounty` sweep remaining escrow back to the poster once windows close
 *
 * One `sign*` function per variant. Each builds the borsh-encoded
 * `RuntimeCall::Bounty(...)` bytes and hands off to
 * [`wrapAndSign`](./transaction.ts), which appends the uniqueness +
 * details envelope, signs over `body || chain_hash`, and wraps in
 * `Transaction::V0`. The returned bytes are ready to base64 + POST to
 * `/v1/sequencer/txs`.
 *
 * ## Wire format anchors
 *
 * `RuntimeCall::Bounty = 0x0A` (the 11th module in the runtime
 * declaration order, right after `attestation = 0x09`; see
 * `ligate-stf-declaration::Runtime`). Inner `CallMessage`
 * discriminants follow declaration order in
 * `crates/modules/bounty/src/lib.rs`. The byte layout is pinned by the
 * Rust fixture probe at
 * `ligate-chain/crates/bootstrap-cli/examples/disc_probe.rs`;
 * `test/bounty.test.ts` re-encodes the same fixtures in TS and asserts
 * byte equality, so a runtime-composition or field-order shift breaks
 * loudly here rather than silently producing chain-rejected txs.
 *
 * Shared encodings (see `borsh.ts` + `attestation.ts`):
 * - `Amount` = `u128` little-endian (16 bytes)
 * - id types (`SchemaId`, `AttestationId`, `AttestorSetId`,
 *   `PayloadHash`, `BountyId`) = 32 raw bytes, with bech32m display forms
 * - `SafeVec<T, N>` = `u32` LE length + N items
 */

import { bech32m } from '@scure/base'

import {
  ATTESTATION_HRP,
  ATTESTOR_SET_HRP,
  PAYLOAD_HASH_HRP,
  SCHEMA_HRP,
  idToBytes,
} from './attestation.js'
import { BorshWriter } from './borsh.js'
import { wrapAndSign } from './transaction.js'
import type { SignEnvelopeParams } from './transaction.js'

// ---- Discriminants ---------------------------------------------------------

/** Outer discriminant for `RuntimeCall::Bounty(...)`. */
export const RUNTIME_BOUNTY_DISC = 0x0a

/** Inner: `CallMessage::PostBounty`. */
export const POST_BOUNTY_DISC = 0x00
/** Inner: `CallMessage::ClaimBounty`. */
export const CLAIM_BOUNTY_DISC = 0x01
/** Inner: `CallMessage::DisputeAttestation`. */
export const DISPUTE_ATTESTATION_DISC = 0x02
/** Inner: `CallMessage::ResolveDispute`. */
export const RESOLVE_DISPUTE_DISC = 0x03
/** Inner: `CallMessage::CancelBounty`. */
export const CANCEL_BOUNTY_DISC = 0x04
/** Inner: `CallMessage::FinaliseBounty`. */
export const FINALISE_BOUNTY_DISC = 0x05

// ---- BountyId --------------------------------------------------------------

/** HRP for `BountyId` bech32m strings (`lbt1...`). */
export const BOUNTY_HRP = 'lbt'
/** `BountyId` is 32 bytes underneath. */
export const BOUNTY_ID_BYTE_LENGTH = 32

/** Encode 32 raw bytes as `lbt1...`. */
export function encodeBountyId(bytes: Uint8Array): string {
  if (bytes.length !== BOUNTY_ID_BYTE_LENGTH) {
    throw new Error(`expected ${BOUNTY_ID_BYTE_LENGTH}-byte bounty id, got ${bytes.length}`)
  }
  return bech32m.encode(BOUNTY_HRP, bech32m.toWords(bytes))
}

/** Decode `lbt1...` to 32 raw bytes. */
export function decodeBountyId(s: string): Uint8Array {
  const decoded = bech32m.decode(s as `${string}1${string}`)
  if (decoded.prefix !== BOUNTY_HRP) {
    throw new Error(`expected '${BOUNTY_HRP}' bech32m prefix, got '${decoded.prefix}' in ${s}`)
  }
  const bytes = bech32m.fromWords(decoded.words)
  if (bytes.length !== BOUNTY_ID_BYTE_LENGTH) {
    throw new Error(`expected ${BOUNTY_ID_BYTE_LENGTH}-byte bounty id payload, got ${bytes.length}`)
  }
  return Uint8Array.from(bytes)
}

// ---- Acceptance predicate --------------------------------------------------

/**
 * Rule the chain uses to decide which attestations count as valid
 * claims. Mirrors `bounty::AcceptancePredicate`:
 *
 * - `any` (disc 0): any valid attestation against the board schema
 * - `attestorSet` (disc 1): only attestations from a given attestor set
 * - `payloadHashes` (disc 2): only attestations whose payload hash is listed
 * - `peerCount` (disc 3): at least `minAttestors` distinct-attestor peers
 */
export type AcceptancePredicate =
  | { kind: 'any' }
  | { kind: 'attestorSet'; attestorSetId: string | Uint8Array }
  | { kind: 'payloadHashes'; payloadHashes: Array<string | Uint8Array> }
  | { kind: 'peerCount'; minAttestors: number }

/** Hard cap on `payloadHashes` list length (per `bounty::MAX_PAYLOAD_HASHES`). */
export const MAX_PAYLOAD_HASHES = 256
/** Hard cap on `ClaimBounty.claims` batch length (per `bounty::MAX_CLAIMS_PER_CALL`). */
export const MAX_CLAIMS_PER_CALL = 64

function writeAcceptancePredicate(w: BorshWriter, p: AcceptancePredicate): void {
  switch (p.kind) {
    case 'any':
      w.writeU8(0x00)
      return
    case 'attestorSet':
      w.writeU8(0x01)
      w.writeFixedBytes(idToBytes(p.attestorSetId, ATTESTOR_SET_HRP), 32)
      return
    case 'payloadHashes': {
      if (p.payloadHashes.length > MAX_PAYLOAD_HASHES) {
        throw new Error(
          `payloadHashes exceeds MAX_PAYLOAD_HASHES (${MAX_PAYLOAD_HASHES}); got ${p.payloadHashes.length}`,
        )
      }
      w.writeU8(0x02)
      // SafeVec<PayloadHash, _>: u32 LE len + N x 32 bytes.
      w.writeU32(p.payloadHashes.length)
      for (const ph of p.payloadHashes) {
        w.writeFixedBytes(idToBytes(ph, PAYLOAD_HASH_HRP), 32)
      }
      return
    }
    case 'peerCount':
      if (p.minAttestors < 0 || p.minAttestors > 0xff) {
        throw new Error(`minAttestors out of u8 range: ${p.minAttestors}`)
      }
      w.writeU8(0x03)
      w.writeU8(p.minAttestors & 0xff)
      return
    default: {
      // Exhaustiveness guard.
      const never: never = p
      throw new Error(`unknown acceptance predicate: ${JSON.stringify(never)}`)
    }
  }
}

// ---- Dispute enums ---------------------------------------------------------

/** Reason a dispute is filed. Mirrors `bounty::DisputeGround` (disc order). */
export type DisputeGround = 'acceptanceMismatch' | 'invalidPayload' | 'staleAttestorSet' | 'other'

const DISPUTE_GROUND_DISC: Record<DisputeGround, number> = {
  acceptanceMismatch: 0x00,
  invalidPayload: 0x01,
  staleAttestorSet: 0x02,
  other: 0x03,
}

/** Outcome of a `ResolveDispute` call. Mirrors `bounty::DisputeDecision`. */
export type DisputeDecision = 'accept' | 'reject'

const DISPUTE_DECISION_DISC: Record<DisputeDecision, number> = {
  accept: 0x00,
  reject: 0x01,
}

// ---- Builders --------------------------------------------------------------

/** Inputs to [`signPostBounty`]. */
export interface SignPostBountyParams extends SignEnvelopeParams {
  /** Board schema the bounty composes against. `lsc1...`, hex, or 32 bytes. */
  boardSchemaId: string | Uint8Array
  /** Total `AVOW` to escrow, in nano-AVOW. */
  poolNano: bigint
  /** Payout per accepted claim, in nano-AVOW. */
  perAttestationNano: bigint
  /** Filter rule for valid claims. */
  acceptance: AcceptancePredicate
  /** DA-layer block height the bounty expires at. */
  expiryDaHeight: bigint
  /** Dispute window, in chain blocks, after each claim. */
  disputeWindowBlocks: number
}

/**
 * Build, sign, and borsh-encode a `PostBounty` transaction.
 *
 * The chain derives the resulting `BountyId` from
 * `SHA-256(poster_addr || board_schema_id || nonce_le)` at execution
 * time; read it back from the `BountyPosted` event or the indexer
 * (`GET /v1/bounties`) after inclusion.
 */
export function signPostBounty(params: SignPostBountyParams): Uint8Array {
  if (params.disputeWindowBlocks < 0 || params.disputeWindowBlocks > 0xffffffff) {
    throw new Error(`disputeWindowBlocks out of u32 range: ${params.disputeWindowBlocks}`)
  }
  const w = new BorshWriter()
  w.writeU8(RUNTIME_BOUNTY_DISC)
  w.writeU8(POST_BOUNTY_DISC)
  w.writeFixedBytes(idToBytes(params.boardSchemaId, SCHEMA_HRP), 32)
  w.writeU128(params.poolNano)
  w.writeU128(params.perAttestationNano)
  writeAcceptancePredicate(w, params.acceptance)
  w.writeU64(params.expiryDaHeight)
  w.writeU32(params.disputeWindowBlocks)
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to [`signClaimBounty`]. */
export interface SignClaimBountyParams extends SignEnvelopeParams {
  /** Bounty being claimed against. `lbt1...`, hex, or 32 bytes. */
  bountyId: string | Uint8Array
  /**
   * Attestation ids to claim, one `AttestationClaim` each. `lat1...`,
   * hex, or 32 bytes. Capped at `MAX_CLAIMS_PER_CALL`.
   */
  attestationIds: Array<string | Uint8Array>
}

/** Build, sign, and borsh-encode a `ClaimBounty` transaction. */
export function signClaimBounty(params: SignClaimBountyParams): Uint8Array {
  if (params.attestationIds.length === 0) {
    throw new Error('attestationIds must not be empty')
  }
  if (params.attestationIds.length > MAX_CLAIMS_PER_CALL) {
    throw new Error(
      `attestationIds exceeds MAX_CLAIMS_PER_CALL (${MAX_CLAIMS_PER_CALL}); got ${params.attestationIds.length}`,
    )
  }
  const w = new BorshWriter()
  w.writeU8(RUNTIME_BOUNTY_DISC)
  w.writeU8(CLAIM_BOUNTY_DISC)
  w.writeFixedBytes(idToBytes(params.bountyId, BOUNTY_HRP), 32)
  // claims: SafeVec<AttestationClaim, _>. AttestationClaim is a struct
  // with one field (attestation_id: [u8; 32]), so the element encoding
  // is just the 32 raw id bytes.
  w.writeU32(params.attestationIds.length)
  for (const aid of params.attestationIds) {
    w.writeFixedBytes(idToBytes(aid, ATTESTATION_HRP), 32)
  }
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to [`signDisputeAttestation`]. */
export interface SignDisputeAttestationParams extends SignEnvelopeParams {
  /** Bounty whose claim is disputed. `lbt1...`, hex, or 32 bytes. */
  bountyId: string | Uint8Array
  /** Contested attestation. `lat1...`, hex, or 32 bytes. */
  attestationId: string | Uint8Array
  /** Why the dispute is filed. */
  ground: DisputeGround
}

/** Build, sign, and borsh-encode a `DisputeAttestation` transaction. */
export function signDisputeAttestation(params: SignDisputeAttestationParams): Uint8Array {
  const w = new BorshWriter()
  w.writeU8(RUNTIME_BOUNTY_DISC)
  w.writeU8(DISPUTE_ATTESTATION_DISC)
  w.writeFixedBytes(idToBytes(params.bountyId, BOUNTY_HRP), 32)
  w.writeFixedBytes(idToBytes(params.attestationId, ATTESTATION_HRP), 32)
  w.writeU8(DISPUTE_GROUND_DISC[params.ground])
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to [`signResolveDispute`]. */
export interface SignResolveDisputeParams extends SignEnvelopeParams {
  /** Bounty whose dispute is resolved. `lbt1...`, hex, or 32 bytes. */
  bountyId: string | Uint8Array
  /** Attestation whose claim is resolved. `lat1...`, hex, or 32 bytes. */
  attestationId: string | Uint8Array
  /** Accept or reject the claim. */
  decision: DisputeDecision
}

/** Build, sign, and borsh-encode a `ResolveDispute` transaction. */
export function signResolveDispute(params: SignResolveDisputeParams): Uint8Array {
  const w = new BorshWriter()
  w.writeU8(RUNTIME_BOUNTY_DISC)
  w.writeU8(RESOLVE_DISPUTE_DISC)
  w.writeFixedBytes(idToBytes(params.bountyId, BOUNTY_HRP), 32)
  w.writeFixedBytes(idToBytes(params.attestationId, ATTESTATION_HRP), 32)
  w.writeU8(DISPUTE_DECISION_DISC[params.decision])
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to [`signCancelBounty`] / [`signFinaliseBounty`]. */
export interface SignBountyIdParams extends SignEnvelopeParams {
  /** Bounty to act on. `lbt1...`, hex, or 32 bytes. */
  bountyId: string | Uint8Array
}

/** Build, sign, and borsh-encode a `CancelBounty` transaction. */
export function signCancelBounty(params: SignBountyIdParams): Uint8Array {
  const w = new BorshWriter()
  w.writeU8(RUNTIME_BOUNTY_DISC)
  w.writeU8(CANCEL_BOUNTY_DISC)
  w.writeFixedBytes(idToBytes(params.bountyId, BOUNTY_HRP), 32)
  return wrapAndSign(w.bytes(), params)
}

/** Build, sign, and borsh-encode a `FinaliseBounty` transaction. */
export function signFinaliseBounty(params: SignBountyIdParams): Uint8Array {
  const w = new BorshWriter()
  w.writeU8(RUNTIME_BOUNTY_DISC)
  w.writeU8(FINALISE_BOUNTY_DISC)
  w.writeFixedBytes(idToBytes(params.bountyId, BOUNTY_HRP), 32)
  return wrapAndSign(w.bytes(), params)
}
