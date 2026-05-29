/**
 * Contract builder fixture tests.
 *
 * Pins the borsh-encoded `RuntimeCall::Contracts(...)` bytes against
 * fixtures captured from the chain side via
 * `ligate-chain/crates/bootstrap-cli/examples/disc_probe.rs`. The
 * contract module's `CallMessage` is `#[non_exhaustive]` and defines
 * its own `DisputeGround` / `DisputeDecision` enums distinct from the
 * bounty module's; these fixtures lock both the discriminants and the
 * field layout.
 *
 * Runtime-call bytes are sliced out of the signed envelope at
 * [97..97+rc_len] (1-byte tag + 64-byte sig + 32-byte pubkey header).
 */

import { describe, expect, it } from 'vitest'

import {
  ACCEPT_DELIVERY_DISC,
  CANCEL_CONTRACT_DISC,
  COMMIT_TO_CONTRACT_DISC,
  CONTRACT_HRP,
  DELIVER_CONTRACT_DISC,
  FINALIZE_DELIVERY_DISC,
  POST_CONTRACT_DISC,
  REJECT_DELIVERY_DISC,
  RESOLVE_CONTRACT_DISPUTE_DISC,
  RUNTIME_CONTRACTS_DISC,
  decodeContractId,
  encodeContractId,
  signAcceptDelivery,
  signCancelContract,
  signCommitToContract,
  signDeliverContract,
  signFinalizeDelivery,
  signPostContract,
  signRejectDelivery,
  signResolveContractDispute,
} from '../src/contract.js'
import { keypairFromPrivateKey } from '../src/keys.js'

const DEV_PRIVATE_KEY = '01'.repeat(32)
const DUMMY_CHAIN_HASH = 'bb'.repeat(32)
const ENVELOPE_HEADER_LEN = 1 + 64 + 32 // 0x00 + sig + pubkey

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function runtimeCallSlice(envelope: Uint8Array, expectedLen: number): Uint8Array {
  return envelope.slice(ENVELOPE_HEADER_LEN, ENVELOPE_HEADER_LEN + expectedLen)
}

const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
const ENVELOPE = {
  privateKey: kp.privateKeyHex,
  publicKey: kp.publicKey,
  nonce: 0n,
  chainId: 4242n,
  chainHash: DUMMY_CHAIN_HASH,
}

const fill = (byte: number, len = 32) => new Uint8Array(len).fill(byte)

describe('discriminants', () => {
  it('pins the chain-side discriminants', () => {
    expect(RUNTIME_CONTRACTS_DISC).toBe(0x0b)
    expect(POST_CONTRACT_DISC).toBe(0x00)
    expect(COMMIT_TO_CONTRACT_DISC).toBe(0x01)
    expect(DELIVER_CONTRACT_DISC).toBe(0x02)
    expect(ACCEPT_DELIVERY_DISC).toBe(0x03)
    expect(REJECT_DELIVERY_DISC).toBe(0x04)
    expect(RESOLVE_CONTRACT_DISPUTE_DISC).toBe(0x05)
    expect(CANCEL_CONTRACT_DISC).toBe(0x06)
    expect(FINALIZE_DELIVERY_DISC).toBe(0x07)
  })
})

describe('signPostContract', () => {
  // disc_probe.rs: Contracts::PostContract (0x42 arbiter, 0x33 criteria).
  const FIXTURE = hexToBytes(
    '0b000042424242424242424242424242424242424242424242424242424242333333333333333333333333333333333333333333333333333333333333333300943577000000000000000000000000e70300000000000032000000f401',
  )

  it('matches the chain fixture', () => {
    const envelope = signPostContract({
      ...ENVELOPE,
      arbiter: fill(0x42, 28),
      criteriaDocHash: fill(0x33),
      poolNano: 2_000_000_000n,
      expiryDaHeight: 999n,
      disputeWindowBlocks: 50,
      arbiterFeeBps: 500,
    })
    expect(runtimeCallSlice(envelope, FIXTURE.length)).toEqual(FIXTURE)
  })

  it('rejects a non-28-byte arbiter', () => {
    expect(() =>
      signPostContract({
        ...ENVELOPE,
        arbiter: fill(0x42, 32),
        criteriaDocHash: fill(0x33),
        poolNano: 1n,
        expiryDaHeight: 1n,
        disputeWindowBlocks: 1,
        arbiterFeeBps: 0,
      }),
    ).toThrow(/28 bytes/)
  })
})

describe('signCommitToContract', () => {
  // disc_probe.rs: Contracts::CommitToContract (0x44 contract, 0x55 commit).
  const FIXTURE = hexToBytes(
    '0b01444444444444444444444444444444444444444444444444444444444444444455555555555555555555555555555555555555555555555555555555555555550065cd1d000000000000000000000000',
  )

  it('matches the chain fixture', () => {
    const envelope = signCommitToContract({
      ...ENVELOPE,
      contractId: fill(0x44),
      commitHash: fill(0x55),
      bondNano: 500_000_000n,
    })
    expect(runtimeCallSlice(envelope, FIXTURE.length)).toEqual(FIXTURE)
  })
})

describe('signDeliverContract', () => {
  // disc_probe.rs: Contracts::DeliverContract (0x44 contract, 0x22 attestation).
  const FIXTURE = hexToBytes(
    '0b0244444444444444444444444444444444444444444444444444444444444444442222222222222222222222222222222222222222222222222222222222222222',
  )

  it('matches the chain fixture', () => {
    const envelope = signDeliverContract({
      ...ENVELOPE,
      contractId: fill(0x44),
      deliverableAttestationId: fill(0x22),
    })
    expect(runtimeCallSlice(envelope, FIXTURE.length)).toEqual(FIXTURE)
  })
})

describe('signRejectDelivery', () => {
  // disc_probe.rs: Contracts::RejectDelivery (ground=Other).
  const FIXTURE = hexToBytes(
    '0b04444444444444444444444444444444444444444444444444444444444444444403',
  )

  it('matches the chain fixture (ground=other)', () => {
    const envelope = signRejectDelivery({
      ...ENVELOPE,
      contractId: fill(0x44),
      ground: 'other',
    })
    expect(runtimeCallSlice(envelope, FIXTURE.length)).toEqual(FIXTURE)
  })
})

describe('signResolveContractDispute', () => {
  // disc_probe.rs: Contracts::ResolveContractDispute (RejectDelivery).
  const FIXTURE = hexToBytes(
    '0b05444444444444444444444444444444444444444444444444444444444444444401',
  )

  it('matches the chain fixture (decision=rejectDelivery)', () => {
    const envelope = signResolveContractDispute({
      ...ENVELOPE,
      contractId: fill(0x44),
      decision: 'rejectDelivery',
    })
    expect(runtimeCallSlice(envelope, FIXTURE.length)).toEqual(FIXTURE)
  })
})

describe('signAcceptDelivery / signCancelContract / signFinalizeDelivery', () => {
  // disc_probe.rs: Contracts::AcceptDelivery (0x44 contract).
  const ACCEPT = hexToBytes('0b034444444444444444444444444444444444444444444444444444444444444444')
  // Same fixed `{ contract_id }` shape, inner disc 0x06 / 0x07.
  const CANCEL = hexToBytes('0b064444444444444444444444444444444444444444444444444444444444444444')
  const FINALIZE = hexToBytes(
    '0b074444444444444444444444444444444444444444444444444444444444444444',
  )

  it('matches the chain fixture for AcceptDelivery', () => {
    const envelope = signAcceptDelivery({ ...ENVELOPE, contractId: fill(0x44) })
    expect(runtimeCallSlice(envelope, ACCEPT.length)).toEqual(ACCEPT)
  })

  it('encodes CancelContract with the 0x06 inner discriminant', () => {
    const envelope = signCancelContract({ ...ENVELOPE, contractId: fill(0x44) })
    expect(runtimeCallSlice(envelope, CANCEL.length)).toEqual(CANCEL)
  })

  it('encodes FinalizeDelivery with the 0x07 inner discriminant', () => {
    const envelope = signFinalizeDelivery({ ...ENVELOPE, contractId: fill(0x44) })
    expect(runtimeCallSlice(envelope, FINALIZE.length)).toEqual(FINALIZE)
  })
})

describe('ContractId codec', () => {
  it('round-trips lct1 bech32m', () => {
    const raw = fill(0x44)
    const encoded = encodeContractId(raw)
    expect(encoded.startsWith('lct1')).toBe(true)
    expect(decodeContractId(encoded)).toEqual(raw)
  })

  it('exposes the lct HRP', () => {
    expect(CONTRACT_HRP).toBe('lct')
  })
})
