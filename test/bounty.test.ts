/**
 * Bounty builder fixture tests.
 *
 * Pins the borsh-encoded `RuntimeCall::Bounty(...)` bytes against
 * fixtures captured from the chain side via
 * `ligate-chain/crates/bootstrap-cli/examples/disc_probe.rs`. If a
 * Sovereign SDK pin shifts module composition or the bounty
 * `CallMessage` field order, the runtime-call layout changes and these
 * tests break loudly rather than silently producing chain-rejected txs.
 *
 * The full envelope (`Transaction::V0(Version0)`) carries a
 * non-deterministic signature, so we slice bytes [97..97+rc_len] to
 * compare just the runtime-call portion (which IS deterministic).
 */

import { describe, expect, it } from 'vitest'

import {
  BOUNTY_HRP,
  CANCEL_BOUNTY_DISC,
  CLAIM_BOUNTY_DISC,
  DISPUTE_ATTESTATION_DISC,
  FINALISE_BOUNTY_DISC,
  POST_BOUNTY_DISC,
  RESOLVE_DISPUTE_DISC,
  RUNTIME_BOUNTY_DISC,
  decodeBountyId,
  encodeBountyId,
  signCancelBounty,
  signClaimBounty,
  signDisputeAttestation,
  signFinaliseBounty,
  signPostBounty,
  signResolveDispute,
} from '../src/bounty.js'
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

/** Slice the runtime-call portion out of a signed-envelope byte array. */
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
    expect(RUNTIME_BOUNTY_DISC).toBe(0x0a)
    expect(POST_BOUNTY_DISC).toBe(0x00)
    expect(CLAIM_BOUNTY_DISC).toBe(0x01)
    expect(DISPUTE_ATTESTATION_DISC).toBe(0x02)
    expect(RESOLVE_DISPUTE_DISC).toBe(0x03)
    expect(CANCEL_BOUNTY_DISC).toBe(0x04)
    expect(FINALISE_BOUNTY_DISC).toBe(0x05)
  })
})

describe('signPostBounty', () => {
  // disc_probe.rs: Bounty::PostBounty (Any, CC schema).
  const FIXTURE_ANY = hexToBytes(
    '0a00cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc00ca9a3b00000000000000000000000000e1f50500000000000000000000000000393000000000000064000000',
  )
  // disc_probe.rs: Bounty::PostBounty (PeerCount=3).
  const FIXTURE_PEER = hexToBytes(
    '0a00cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc00ca9a3b00000000000000000000000000e1f5050000000000000000000000000303393000000000000064000000',
  )

  it('matches the chain fixture for the Any predicate', () => {
    const envelope = signPostBounty({
      ...ENVELOPE,
      boardSchemaId: fill(0xcc),
      poolNano: 1_000_000_000n,
      perAttestationNano: 100_000_000n,
      acceptance: { kind: 'any' },
      expiryDaHeight: 12_345n,
      disputeWindowBlocks: 100,
    })
    expect(runtimeCallSlice(envelope, FIXTURE_ANY.length)).toEqual(FIXTURE_ANY)
  })

  it('matches the chain fixture for the PeerCount predicate', () => {
    const envelope = signPostBounty({
      ...ENVELOPE,
      boardSchemaId: fill(0xcc),
      poolNano: 1_000_000_000n,
      perAttestationNano: 100_000_000n,
      acceptance: { kind: 'peerCount', minAttestors: 3 },
      expiryDaHeight: 12_345n,
      disputeWindowBlocks: 100,
    })
    expect(runtimeCallSlice(envelope, FIXTURE_PEER.length)).toEqual(FIXTURE_PEER)
  })
})

describe('signClaimBounty', () => {
  // disc_probe.rs: Bounty::ClaimBounty (1 claim, 0x22 attestation).
  const FIXTURE = hexToBytes(
    '0a011111111111111111111111111111111111111111111111111111111111111111010000002222222222222222222222222222222222222222222222222222222222222222',
  )

  it('matches the chain fixture for a single claim', () => {
    const envelope = signClaimBounty({
      ...ENVELOPE,
      bountyId: fill(0x11),
      attestationIds: [fill(0x22)],
    })
    expect(runtimeCallSlice(envelope, FIXTURE.length)).toEqual(FIXTURE)
  })

  it('rejects an empty claim batch', () => {
    expect(() =>
      signClaimBounty({ ...ENVELOPE, bountyId: fill(0x11), attestationIds: [] }),
    ).toThrow(/empty/)
  })
})

describe('signDisputeAttestation', () => {
  // disc_probe.rs: Bounty::DisputeAttestation (ground=Other).
  const FIXTURE = hexToBytes(
    '0a021111111111111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222222222222203',
  )

  it('matches the chain fixture (ground=other)', () => {
    const envelope = signDisputeAttestation({
      ...ENVELOPE,
      bountyId: fill(0x11),
      attestationId: fill(0x22),
      ground: 'other',
    })
    expect(runtimeCallSlice(envelope, FIXTURE.length)).toEqual(FIXTURE)
  })
})

describe('signResolveDispute', () => {
  // disc_probe.rs: Bounty::ResolveDispute (decision=Reject).
  const FIXTURE = hexToBytes(
    '0a031111111111111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222222222222201',
  )

  it('matches the chain fixture (decision=reject)', () => {
    const envelope = signResolveDispute({
      ...ENVELOPE,
      bountyId: fill(0x11),
      attestationId: fill(0x22),
      decision: 'reject',
    })
    expect(runtimeCallSlice(envelope, FIXTURE.length)).toEqual(FIXTURE)
  })
})

describe('signCancelBounty / signFinaliseBounty', () => {
  // disc_probe.rs: Bounty::CancelBounty (0x11 bounty).
  const CANCEL = hexToBytes('0a041111111111111111111111111111111111111111111111111111111111111111')
  // Same fixed `{ bounty_id }` shape as Cancel, inner disc 0x05.
  const FINALISE = hexToBytes(
    '0a051111111111111111111111111111111111111111111111111111111111111111',
  )

  it('matches the chain fixture for CancelBounty', () => {
    const envelope = signCancelBounty({ ...ENVELOPE, bountyId: fill(0x11) })
    expect(runtimeCallSlice(envelope, CANCEL.length)).toEqual(CANCEL)
  })

  it('encodes FinaliseBounty with the 0x05 inner discriminant', () => {
    const envelope = signFinaliseBounty({ ...ENVELOPE, bountyId: fill(0x11) })
    expect(runtimeCallSlice(envelope, FINALISE.length)).toEqual(FINALISE)
  })
})

describe('BountyId codec', () => {
  it('round-trips lbt1 bech32m', () => {
    const raw = fill(0x11)
    const encoded = encodeBountyId(raw)
    expect(encoded.startsWith('lbt1')).toBe(true)
    expect(decodeBountyId(encoded)).toEqual(raw)
  })

  it('exposes the lbt HRP', () => {
    expect(BOUNTY_HRP).toBe('lbt')
  })

  it('rejects wrong-HRP input', () => {
    // An lct1 (contract) id must not decode as a bounty id.
    const lct = 'lct1' // truncated, decode should throw on prefix or length
    expect(() => decodeBountyId(lct)).toThrow()
  })
})
