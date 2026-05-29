/**
 * Work-for-hire contract runtime-call builders.
 *
 * The chain's `contract` module ships eight user-callable
 * `CallMessage` variants for the deliverable-contract lifecycle:
 *
 * - `PostContract` post + escrow a buyer-funded contract with a named arbiter
 * - `CommitToContract` worker bonds + commits to deliver
 * - `DeliverContract` worker reveals + delivers, referencing a proof attestation
 * - `AcceptDelivery` poster accepts; pool settles to the worker
 * - `RejectDelivery` poster rejects; transitions to disputed
 * - `ResolveContractDispute` arbiter resolves an open dispute
 * - `CancelContract` poster cancels an unaccepted/expired contract
 * - `FinalizeDelivery` permissionless auto-accept once the window elapses
 *
 * One `sign*` function per variant. Each builds the borsh-encoded
 * `RuntimeCall::Contracts(...)` bytes and hands off to
 * [`wrapAndSign`](./transaction.ts) for the envelope + signature.
 * Returned bytes are ready to base64 + POST to `/v1/sequencer/txs`.
 *
 * ## Wire format anchors
 *
 * `RuntimeCall::Contracts = 0x0B` (the 12th module in the runtime
 * declaration order, right after `bounty = 0x0A`; see
 * `ligate-stf-declaration::Runtime`). Note the runtime field is
 * `contracts` (plural), so the REST mount is `/v1/modules/contracts/`
 * and the indexer surface is `/v1/contracts`. Inner `CallMessage`
 * discriminants follow declaration order in
 * `crates/modules/contract/src/lib.rs`. Byte layout is pinned by the
 * Rust fixture probe at
 * `ligate-chain/crates/bootstrap-cli/examples/disc_probe.rs`;
 * `test/contract.test.ts` re-encodes the same fixtures in TS and
 * asserts byte equality.
 *
 * The contract module defines its OWN `DisputeGround` /
 * `DisputeDecision` enums, distinct from the bounty module's: the
 * grounds and the decision variant names differ even though both
 * serialise as positional `u8` discriminants. Do not share these with
 * the bounty types.
 */

import { bech32m } from '@scure/base'

import { decodeAddress } from './address.js'
import { ATTESTATION_HRP, idToBytes } from './attestation.js'
import { BorshWriter } from './borsh.js'
import { bytesArg, wrapAndSign } from './transaction.js'
import type { SignEnvelopeParams } from './transaction.js'

// ---- Discriminants ---------------------------------------------------------

/** Outer discriminant for `RuntimeCall::Contracts(...)`. */
export const RUNTIME_CONTRACTS_DISC = 0x0b

/** Inner: `CallMessage::PostContract`. */
export const POST_CONTRACT_DISC = 0x00
/** Inner: `CallMessage::CommitToContract`. */
export const COMMIT_TO_CONTRACT_DISC = 0x01
/** Inner: `CallMessage::DeliverContract`. */
export const DELIVER_CONTRACT_DISC = 0x02
/** Inner: `CallMessage::AcceptDelivery`. */
export const ACCEPT_DELIVERY_DISC = 0x03
/** Inner: `CallMessage::RejectDelivery`. */
export const REJECT_DELIVERY_DISC = 0x04
/** Inner: `CallMessage::ResolveContractDispute`. */
export const RESOLVE_CONTRACT_DISPUTE_DISC = 0x05
/** Inner: `CallMessage::CancelContract`. */
export const CANCEL_CONTRACT_DISC = 0x06
/** Inner: `CallMessage::FinalizeDelivery`. */
export const FINALIZE_DELIVERY_DISC = 0x07

/** `MultiAddress::Standard(Address)` discriminant. */
const ADDR_STANDARD_DISC = 0x00

// ---- ContractId ------------------------------------------------------------

/** HRP for `ContractId` bech32m strings (`lct1...`). */
export const CONTRACT_HRP = 'lct'
/** `ContractId` is 32 bytes underneath. */
export const CONTRACT_ID_BYTE_LENGTH = 32

/** Encode 32 raw bytes as `lct1...`. */
export function encodeContractId(bytes: Uint8Array): string {
  if (bytes.length !== CONTRACT_ID_BYTE_LENGTH) {
    throw new Error(`expected ${CONTRACT_ID_BYTE_LENGTH}-byte contract id, got ${bytes.length}`)
  }
  return bech32m.encode(CONTRACT_HRP, bech32m.toWords(bytes))
}

/** Decode `lct1...` to 32 raw bytes. */
export function decodeContractId(s: string): Uint8Array {
  const decoded = bech32m.decode(s as `${string}1${string}`)
  if (decoded.prefix !== CONTRACT_HRP) {
    throw new Error(`expected '${CONTRACT_HRP}' bech32m prefix, got '${decoded.prefix}' in ${s}`)
  }
  const bytes = bech32m.fromWords(decoded.words)
  if (bytes.length !== CONTRACT_ID_BYTE_LENGTH) {
    throw new Error(
      `expected ${CONTRACT_ID_BYTE_LENGTH}-byte contract id payload, got ${bytes.length}`,
    )
  }
  return Uint8Array.from(bytes)
}

// ---- Dispute enums (contract-module-local) ---------------------------------

/** Reason a delivery is rejected. Mirrors `contract::DisputeGround`. */
export type ContractDisputeGround =
  | 'criteriaMismatch'
  | 'malformedDelivery'
  | 'expiredAtDelivery'
  | 'other'

const CONTRACT_DISPUTE_GROUND_DISC: Record<ContractDisputeGround, number> = {
  criteriaMismatch: 0x00,
  malformedDelivery: 0x01,
  expiredAtDelivery: 0x02,
  other: 0x03,
}

/** Arbiter's resolution. Mirrors `contract::DisputeDecision`. */
export type ContractDisputeDecision = 'acceptDelivery' | 'rejectDelivery'

const CONTRACT_DISPUTE_DECISION_DISC: Record<ContractDisputeDecision, number> = {
  acceptDelivery: 0x00,
  rejectDelivery: 0x01,
}

// ---- Builders --------------------------------------------------------------

/** Inputs to [`signPostContract`]. */
export interface SignPostContractParams extends SignEnvelopeParams {
  /** Arbiter authorised to resolve disputes. `lig1...` or 28 raw bytes. */
  arbiter: string | Uint8Array
  /** 32-byte content hash of the off-chain criteria doc. Hex or 32 bytes. */
  criteriaDocHash: string | Uint8Array
  /** Total `AVOW` to escrow, in nano-AVOW. */
  poolNano: bigint
  /** DA-layer block height the contract expires at. */
  expiryDaHeight: bigint
  /** Window, in chain blocks, the poster has to accept-or-reject a delivery. */
  disputeWindowBlocks: number
  /** Arbiter fee in basis points (1/10000). Paid only if the arbiter resolves. */
  arbiterFeeBps: number
}

/**
 * Build, sign, and borsh-encode a `PostContract` transaction.
 *
 * The chain derives the resulting `ContractId` from
 * `SHA-256(poster_addr || criteria_doc_hash || nonce_le)` at
 * execution time; read it back from the `ContractPosted` event or the
 * indexer (`GET /v1/contracts`) after inclusion.
 */
export function signPostContract(params: SignPostContractParams): Uint8Array {
  if (params.disputeWindowBlocks < 0 || params.disputeWindowBlocks > 0xffffffff) {
    throw new Error(`disputeWindowBlocks out of u32 range: ${params.disputeWindowBlocks}`)
  }
  if (params.arbiterFeeBps < 0 || params.arbiterFeeBps > 0xffff) {
    throw new Error(`arbiterFeeBps out of u16 range: ${params.arbiterFeeBps}`)
  }
  const arbiter =
    params.arbiter instanceof Uint8Array ? params.arbiter : decodeAddress(params.arbiter)
  if (arbiter.length !== 28) {
    throw new Error(`arbiter address must be 28 bytes, got ${arbiter.length}`)
  }
  const w = new BorshWriter()
  w.writeU8(RUNTIME_CONTRACTS_DISC)
  w.writeU8(POST_CONTRACT_DISC)
  // arbiter: MultiAddress::Standard(28-byte address).
  w.writeU8(ADDR_STANDARD_DISC)
  w.writeFixedBytes(arbiter, 28)
  // criteria_doc_hash: [u8; 32] (raw, not a bech32 id).
  w.writeFixedBytes(bytesArg(params.criteriaDocHash, 32, 'criteriaDocHash'), 32)
  w.writeU128(params.poolNano)
  w.writeU64(params.expiryDaHeight)
  w.writeU32(params.disputeWindowBlocks)
  w.writeU16(params.arbiterFeeBps)
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to [`signCommitToContract`]. */
export interface SignCommitToContractParams extends SignEnvelopeParams {
  /** Contract being committed against. `lct1...`, hex, or 32 bytes. */
  contractId: string | Uint8Array
  /** SHA-256 of the deliverable (reveal preimage on deliver). Hex or 32 bytes. */
  commitHash: string | Uint8Array
  /** Bond amount, in nano-AVOW. */
  bondNano: bigint
}

/** Build, sign, and borsh-encode a `CommitToContract` transaction. */
export function signCommitToContract(params: SignCommitToContractParams): Uint8Array {
  const w = new BorshWriter()
  w.writeU8(RUNTIME_CONTRACTS_DISC)
  w.writeU8(COMMIT_TO_CONTRACT_DISC)
  w.writeFixedBytes(idToBytes(params.contractId, CONTRACT_HRP), 32)
  w.writeFixedBytes(bytesArg(params.commitHash, 32, 'commitHash'), 32)
  w.writeU128(params.bondNano)
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to [`signDeliverContract`]. */
export interface SignDeliverContractParams extends SignEnvelopeParams {
  /** Contract being delivered against. `lct1...`, hex, or 32 bytes. */
  contractId: string | Uint8Array
  /** Attestation id pointing at the delivery's proof. `lat1...`, hex, or 32 bytes. */
  deliverableAttestationId: string | Uint8Array
}

/** Build, sign, and borsh-encode a `DeliverContract` transaction. */
export function signDeliverContract(params: SignDeliverContractParams): Uint8Array {
  const w = new BorshWriter()
  w.writeU8(RUNTIME_CONTRACTS_DISC)
  w.writeU8(DELIVER_CONTRACT_DISC)
  w.writeFixedBytes(idToBytes(params.contractId, CONTRACT_HRP), 32)
  w.writeFixedBytes(idToBytes(params.deliverableAttestationId, ATTESTATION_HRP), 32)
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to [`signRejectDelivery`]. */
export interface SignRejectDeliveryParams extends SignEnvelopeParams {
  /** Contract whose delivery is rejected. `lct1...`, hex, or 32 bytes. */
  contractId: string | Uint8Array
  /** Why the delivery is rejected. */
  ground: ContractDisputeGround
}

/** Build, sign, and borsh-encode a `RejectDelivery` transaction. */
export function signRejectDelivery(params: SignRejectDeliveryParams): Uint8Array {
  const w = new BorshWriter()
  w.writeU8(RUNTIME_CONTRACTS_DISC)
  w.writeU8(REJECT_DELIVERY_DISC)
  w.writeFixedBytes(idToBytes(params.contractId, CONTRACT_HRP), 32)
  w.writeU8(CONTRACT_DISPUTE_GROUND_DISC[params.ground])
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to [`signResolveContractDispute`]. */
export interface SignResolveContractDisputeParams extends SignEnvelopeParams {
  /** Contract whose dispute is resolved. `lct1...`, hex, or 32 bytes. */
  contractId: string | Uint8Array
  /** Arbiter's resolution. */
  decision: ContractDisputeDecision
}

/** Build, sign, and borsh-encode a `ResolveContractDispute` transaction. */
export function signResolveContractDispute(params: SignResolveContractDisputeParams): Uint8Array {
  const w = new BorshWriter()
  w.writeU8(RUNTIME_CONTRACTS_DISC)
  w.writeU8(RESOLVE_CONTRACT_DISPUTE_DISC)
  w.writeFixedBytes(idToBytes(params.contractId, CONTRACT_HRP), 32)
  w.writeU8(CONTRACT_DISPUTE_DECISION_DISC[params.decision])
  return wrapAndSign(w.bytes(), params)
}

/** Inputs to the contract calls that take only a `contractId`. */
export interface SignContractIdParams extends SignEnvelopeParams {
  /** Contract to act on. `lct1...`, hex, or 32 bytes. */
  contractId: string | Uint8Array
}

/** Build, sign, and borsh-encode an `AcceptDelivery` transaction. */
export function signAcceptDelivery(params: SignContractIdParams): Uint8Array {
  return signContractIdCall(params, ACCEPT_DELIVERY_DISC)
}

/** Build, sign, and borsh-encode a `CancelContract` transaction. */
export function signCancelContract(params: SignContractIdParams): Uint8Array {
  return signContractIdCall(params, CANCEL_CONTRACT_DISC)
}

/**
 * Build, sign, and borsh-encode a `FinalizeDelivery` transaction.
 *
 * Permissionless: anyone can finalise a delivery whose acceptance
 * window has elapsed (settlement always flows to the worker), so the
 * signer here need not be the poster or worker.
 */
export function signFinalizeDelivery(params: SignContractIdParams): Uint8Array {
  return signContractIdCall(params, FINALIZE_DELIVERY_DISC)
}

/** Shared body for the three `{ contract_id }`-only calls. */
function signContractIdCall(params: SignContractIdParams, innerDisc: number): Uint8Array {
  const w = new BorshWriter()
  w.writeU8(RUNTIME_CONTRACTS_DISC)
  w.writeU8(innerDisc)
  w.writeFixedBytes(idToBytes(params.contractId, CONTRACT_HRP), 32)
  return wrapAndSign(w.bytes(), params)
}
