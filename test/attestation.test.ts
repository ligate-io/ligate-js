/**
 * Attestation builder fixture tests.
 *
 * Pins the borsh-encoded `RuntimeCall::Attestation(...)` bytes
 * against fixtures captured from the chain side via
 * `ligate-chain/crates/bootstrap-cli/examples/disc_probe.rs`. If a
 * Sovereign SDK pin shifts module composition or field order, the
 * runtime-call layout changes and these tests break loudly.
 *
 * The full envelope (`Transaction::V0(Version0)`) includes a
 * non-deterministic signature, so we slice bytes [97..97+rc_len] to
 * compare just the runtime-call portion (which IS deterministic).
 *
 * | Envelope offset | Field |
 * |---|---|
 * | `[0]` | `Transaction::V0` discriminant (`0x00`) |
 * | `[1..65)` | Ed25519 signature (64 bytes, non-deterministic) |
 * | `[65..97)` | signer pubkey (32 bytes) |
 * | `[97..)` | body = runtime_call ++ uniqueness ++ details |
 */

import { describe, expect, it } from 'vitest'

import {
  ATTESTOR_SET_HRP,
  PAYLOAD_HASH_HRP,
  REGISTER_ATTESTOR_SET_DISC,
  REGISTER_SCHEMA_DISC,
  RUNTIME_ATTESTATION_DISC,
  SCHEMA_HRP,
  SUBMIT_ATTESTATION_DISC,
  attestationDigest,
  decodeAttestorSetId,
  decodeSchemaId,
  deriveAttestorSetId,
  deriveSchemaId,
  encodeAttestorSetId,
  encodeSchemaId,
  pubkeyBech32FromPrivateKey,
  signAttestation,
  signRegisterAttestorSet,
  signRegisterSchema,
  signSubmitAttestation,
} from '../src/attestation.js'
import { bytesToHex as keysBytesToHex, keypairFromPrivateKey } from '../src/keys.js'

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

describe('attestationDigest / signAttestation', () => {
  // Canonical test vector from `docs/protocol/attestation-v0.md`
  // §wire-format in the chain repo. Same vector is asserted on by
  // the Rust `attestation_digest` doctest, so any drift between the
  // two implementations is caught at CI time.
  const SCHEMA_ID_HEX = '1c24a84b8307ff2a9e859218d76476932555b5214f8c1c555224b620f8b19486'
  const PAYLOAD_HASH_HEX = 'be6aa821d3f6c3405edcb7cddbcf419e00119e321c6fb46452281dafd55913ac'
  const SUBMITTER_BECH32 = 'lig1zd9j2z6x55ydnv9m8f0pdw3vs2j8u0w5sdqeaf478dzp6s998ac'
  const EXPECTED_DIGEST_HEX = 'b26c0c1698c07e97f3f426ccbdc61ae16dee6f13b780d59c612c7c2b6ba3a079'

  it('produces the LIP-5 canonical digest', () => {
    const digest = attestationDigest({
      schemaId: hexToBytes(SCHEMA_ID_HEX),
      payloadHash: hexToBytes(PAYLOAD_HASH_HEX),
      submitter: SUBMITTER_BECH32,
      timestamp: 0n,
    })
    expect(keysBytesToHex(digest)).toBe(EXPECTED_DIGEST_HEX)
  })

  it('accepts mixed input forms for schema/payload/submitter', () => {
    const lscId = encodeSchemaId(hexToBytes(SCHEMA_ID_HEX))
    const digest = attestationDigest({
      schemaId: lscId,
      payloadHash: PAYLOAD_HASH_HEX,
      submitter: SUBMITTER_BECH32,
    })
    expect(keysBytesToHex(digest)).toBe(EXPECTED_DIGEST_HEX)
  })

  it('signs the digest with the attestor key', () => {
    const attestorPriv = '01'.repeat(32)
    const sig = signAttestation({
      privateKey: attestorPriv,
      schemaId: hexToBytes(SCHEMA_ID_HEX),
      payloadHash: hexToBytes(PAYLOAD_HASH_HEX),
      submitter: SUBMITTER_BECH32,
      timestamp: 0n,
    })
    expect(sig.pubkey.length).toBe(32)
    expect(sig.sig.length).toBe(64)
    // pubkey matches keypairFromPrivateKey derivation.
    expect(keysBytesToHex(sig.pubkey)).toBe(
      keysBytesToHex(keypairFromPrivateKey(attestorPriv).publicKey),
    )
  })

  it('pubkeyBech32FromPrivateKey roundtrips', () => {
    const pk = '01'.repeat(32)
    const lpk = pubkeyBech32FromPrivateKey(pk)
    expect(lpk.startsWith('lpk1')).toBe(true)
  })
})

describe('discriminants', () => {
  it('pins the chain-side discriminants', () => {
    expect(RUNTIME_ATTESTATION_DISC).toBe(0x09)
    expect(REGISTER_ATTESTOR_SET_DISC).toBe(0x00)
    expect(REGISTER_SCHEMA_DISC).toBe(0x01)
    expect(SUBMIT_ATTESTATION_DISC).toBe(0x02)
  })
})

describe('signRegisterAttestorSet', () => {
  // Fixture from `bootstrap-cli/examples/disc_probe.rs`:
  // RegisterAttestorSet (1-of-1, AAA pubkey).
  const FIXTURE_HEX =
    '090001000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01'
  const FIXTURE_BYTES = hexToBytes(FIXTURE_HEX)

  it('produces the chain-pinned runtime-call bytes', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    const member = new Uint8Array(32).fill(0xaa)
    const envelope = signRegisterAttestorSet({
      privateKey: kp.privateKeyHex,
      publicKey: kp.publicKey,
      members: [member],
      threshold: 1,
      nonce: 0n,
      chainId: 4242n,
      chainHash: DUMMY_CHAIN_HASH,
    })
    expect(runtimeCallSlice(envelope, FIXTURE_BYTES.length)).toEqual(FIXTURE_BYTES)
  })

  it('rejects empty members', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    expect(() =>
      signRegisterAttestorSet({
        privateKey: kp.privateKeyHex,
        publicKey: kp.publicKey,
        members: [],
        threshold: 1,
        nonce: 0n,
        chainId: 1n,
        chainHash: DUMMY_CHAIN_HASH,
      }),
    ).toThrow(/empty/)
  })

  it('rejects threshold > member count', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    expect(() =>
      signRegisterAttestorSet({
        privateKey: kp.privateKeyHex,
        publicKey: kp.publicKey,
        members: [new Uint8Array(32).fill(0xaa)],
        threshold: 2,
        nonce: 0n,
        chainId: 1n,
        chainHash: DUMMY_CHAIN_HASH,
      }),
    ).toThrow(/threshold/)
  })
})

describe('signRegisterSchema', () => {
  // Fixture: name='x', version=1, attestor_set=BB×32, fee=0/None,
  // payload_shape_hash=00×32. From disc_probe.rs.
  const FIXTURE_HEX =
    '0901010000007801000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0000000000000000000000000000000000000000000000000000000000000000000000'
  const FIXTURE_BYTES = hexToBytes(FIXTURE_HEX)

  it('produces the chain-pinned runtime-call bytes', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    const envelope = signRegisterSchema({
      privateKey: kp.privateKeyHex,
      publicKey: kp.publicKey,
      name: 'x',
      version: 1,
      attestorSetId: new Uint8Array(32).fill(0xbb),
      payloadShapeHash: new Uint8Array(32),
      nonce: 0n,
      chainId: 4242n,
      chainHash: DUMMY_CHAIN_HASH,
    })
    expect(runtimeCallSlice(envelope, FIXTURE_BYTES.length)).toEqual(FIXTURE_BYTES)
  })

  it('rejects feeRoutingBps > 0 without an addr', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    expect(() =>
      signRegisterSchema({
        privateKey: kp.privateKeyHex,
        publicKey: kp.publicKey,
        name: 'x',
        version: 1,
        attestorSetId: new Uint8Array(32).fill(0xbb),
        payloadShapeHash: new Uint8Array(32),
        feeRoutingBps: 100,
        nonce: 0n,
        chainId: 1n,
        chainHash: DUMMY_CHAIN_HASH,
      }),
    ).toThrow(/feeRoutingAddr/)
  })
})

describe('signSubmitAttestation', () => {
  // Fixture: schema_id=CC×32, payload_hash=DD×32, 1 sig with
  // pubkey=EE×32 + sig=FF×64. From disc_probe.rs.
  const FIXTURE_HEX =
    '0902ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd01000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee40000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  const FIXTURE_BYTES = hexToBytes(FIXTURE_HEX)

  it('produces the chain-pinned runtime-call bytes', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    const envelope = signSubmitAttestation({
      privateKey: kp.privateKeyHex,
      publicKey: kp.publicKey,
      schemaId: new Uint8Array(32).fill(0xcc),
      payloadHash: new Uint8Array(32).fill(0xdd),
      signatures: [
        {
          pubkey: new Uint8Array(32).fill(0xee),
          sig: new Uint8Array(64).fill(0xff),
        },
      ],
      nonce: 0n,
      chainId: 4242n,
      chainHash: DUMMY_CHAIN_HASH,
    })
    expect(runtimeCallSlice(envelope, FIXTURE_BYTES.length)).toEqual(FIXTURE_BYTES)
  })

  it('rejects empty signatures', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    expect(() =>
      signSubmitAttestation({
        privateKey: kp.privateKeyHex,
        publicKey: kp.publicKey,
        schemaId: new Uint8Array(32).fill(0xcc),
        payloadHash: new Uint8Array(32).fill(0xdd),
        signatures: [],
        nonce: 0n,
        chainId: 1n,
        chainHash: DUMMY_CHAIN_HASH,
      }),
    ).toThrow(/empty/)
  })
})

describe('deriveAttestorSetId / encodeAttestorSetId', () => {
  // Pinned: AttestorSet::derive_id(&[AAA;32], 1) =
  // las1g26ad6dgyn5hywvtlc9cp2z0k24f0elelekdv6z52ms0cs579fps6h0vzx
  const EXPECTED = 'las1g26ad6dgyn5hywvtlc9cp2z0k24f0elelekdv6z52ms0cs579fps6h0vzx'

  it('matches the chain-side derivation for [AAA] threshold=1', () => {
    const id = deriveAttestorSetId([new Uint8Array(32).fill(0xaa)], 1)
    expect(id).toHaveLength(32)
    expect(encodeAttestorSetId(id)).toBe(EXPECTED)
  })

  it('round-trips bech32m', () => {
    const id = deriveAttestorSetId([new Uint8Array(32).fill(0xaa)], 1)
    expect(decodeAttestorSetId(encodeAttestorSetId(id))).toEqual(id)
  })

  it('sorts members so order does not affect the id', () => {
    const a = new Uint8Array(32).fill(0x01)
    const b = new Uint8Array(32).fill(0x02)
    const c = new Uint8Array(32).fill(0x03)
    const id1 = deriveAttestorSetId([a, b, c], 2)
    const id2 = deriveAttestorSetId([c, a, b], 2)
    const id3 = deriveAttestorSetId([b, c, a], 2)
    expect(id1).toEqual(id2)
    expect(id2).toEqual(id3)
  })
})

describe('deriveSchemaId / encodeSchemaId', () => {
  // Pinned: Schema::derive_id(0x42×28, "x", 1) =
  // lsc1lwcumlz336grmejfvwm97pn33pes680cr7gc3el57gr34q33dhus0ytxrc
  const EXPECTED = 'lsc1lwcumlz336grmejfvwm97pn33pes680cr7gc3el57gr34q33dhus0ytxrc'

  it('matches the chain-side derivation for (0x42×28, "x", 1)', () => {
    const id = deriveSchemaId(new Uint8Array(28).fill(0x42), 'x', 1)
    expect(id).toHaveLength(32)
    expect(encodeSchemaId(id)).toBe(EXPECTED)
  })

  it('round-trips bech32m', () => {
    const id = deriveSchemaId(new Uint8Array(28).fill(0x42), 'x', 1)
    expect(decodeSchemaId(encodeSchemaId(id))).toEqual(id)
  })

  it('rejects non-28-byte owners', () => {
    expect(() => deriveSchemaId(new Uint8Array(32), 'x', 1)).toThrow(/28 bytes/)
  })
})

describe('id HRPs', () => {
  it('has the four expected HRP constants', () => {
    expect(ATTESTOR_SET_HRP).toBe('las')
    expect(SCHEMA_HRP).toBe('lsc')
    expect(PAYLOAD_HASH_HRP).toBe('lph')
    // PUBKEY_HRP — `lpk`. See attestation.ts for the rationale.
  })
})
