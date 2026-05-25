/**
 * TokenId hex ↔ bech32m round-trip tests.
 *
 * Anchor: the chain's checked-in AVOW gas-token-id at devnet
 * genesis is `token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7`
 * (per `crates/modules/bank/genesis.rs:185` in the Sovereign SDK
 * test fixture). We pin the round-trip from that exact value to
 * the 32-byte form and back so an `@scure/base` upgrade that
 * tightens HRP validation breaks loudly here, not silently
 * elsewhere.
 */

import { describe, expect, it } from 'vitest'

import {
  TOKEN_HRP,
  TOKEN_ID_BYTE_LENGTH,
  decodeTokenIdBech32m,
  encodeTokenIdBech32m,
  tokenIdToBech32m,
  tokenIdToBytes,
  tokenIdToHex,
} from '../src/token.js'

// Canonical AVOW gas-token id from the SDK's bank-genesis test fixture.
const LGT_BECH32M = 'token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7'

describe('encodeTokenIdBech32m / decodeTokenIdBech32m', () => {
  it('round-trips a 32-byte buffer', () => {
    const bytes = new Uint8Array(TOKEN_ID_BYTE_LENGTH)
    for (let i = 0; i < TOKEN_ID_BYTE_LENGTH; i++) bytes[i] = i + 1
    const encoded = encodeTokenIdBech32m(bytes)
    expect(encoded.startsWith(TOKEN_HRP)).toBe(true)
    const decoded = decodeTokenIdBech32m(encoded)
    expect(decoded).toEqual(bytes)
  })

  it('decodes the canonical AVOW id without throwing', () => {
    const bytes = decodeTokenIdBech32m(LGT_BECH32M)
    expect(bytes).toHaveLength(TOKEN_ID_BYTE_LENGTH)
    // Re-encoding should reproduce the original string.
    expect(encodeTokenIdBech32m(bytes)).toBe(LGT_BECH32M)
  })

  it('rejects non-32-byte payloads', () => {
    expect(() => encodeTokenIdBech32m(new Uint8Array(31))).toThrow(/32-byte/)
    expect(() => encodeTokenIdBech32m(new Uint8Array(33))).toThrow(/32-byte/)
  })

  it('rejects a bech32m string with a different HRP', () => {
    // Re-encode the AVOW bytes with the chain's address HRP (`lig`) and
    // try to decode it as a token. Should fail on prefix.
    const bytes = decodeTokenIdBech32m(LGT_BECH32M)
    const ligEncoded =
      'lig1' +
      // We can't easily synthesise a real `lig1...` string from 32 bytes
      // (lig addresses are 28 bytes), so just hand-craft a bad prefix.
      LGT_BECH32M.slice(TOKEN_HRP.length)
    expect(() => decodeTokenIdBech32m(ligEncoded)).toThrow()
    // Sanity: the bytes we decoded above are still 32 bytes.
    expect(bytes).toHaveLength(TOKEN_ID_BYTE_LENGTH)
  })
})

describe('tokenIdToBytes (coercion)', () => {
  const hex = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
  const bytes = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32,
  ])

  it('passes Uint8Array through unchanged', () => {
    expect(tokenIdToBytes(bytes)).toBe(bytes)
  })

  it('decodes 64-char hex (no prefix)', () => {
    expect(tokenIdToBytes(hex)).toEqual(bytes)
  })

  it('decodes 64-char hex (`0x` prefix)', () => {
    expect(tokenIdToBytes('0x' + hex)).toEqual(bytes)
  })

  it('decodes a `token_1...` bech32m string', () => {
    const encoded = encodeTokenIdBech32m(bytes)
    expect(tokenIdToBytes(encoded)).toEqual(bytes)
  })

  it('decodes the canonical AVOW id', () => {
    const out = tokenIdToBytes(LGT_BECH32M)
    expect(out).toHaveLength(TOKEN_ID_BYTE_LENGTH)
  })

  it('rejects 31-byte hex', () => {
    expect(() => tokenIdToBytes('aa'.repeat(31))).toThrow(/32-byte/)
  })

  it('rejects 33-byte Uint8Array', () => {
    expect(() => tokenIdToBytes(new Uint8Array(33))).toThrow(/32-byte/)
  })

  it('rejects non-string non-Uint8Array', () => {
    expect(() => tokenIdToBytes(123 as never)).toThrow(/string or Uint8Array/)
  })
})

describe('tokenIdToBech32m (coercion)', () => {
  const hex = 'aa'.repeat(32)

  it('round-trips bech32m → bech32m', () => {
    const bytes = new Uint8Array(32).fill(0xaa)
    const encoded = encodeTokenIdBech32m(bytes)
    expect(tokenIdToBech32m(encoded)).toBe(encoded)
  })

  it('converts hex to bech32m', () => {
    const out = tokenIdToBech32m(hex)
    expect(out.startsWith(TOKEN_HRP)).toBe(true)
    // Verify round-trip back to the same hex bytes.
    expect(tokenIdToBytes(out)).toEqual(new Uint8Array(32).fill(0xaa))
  })

  it('converts Uint8Array to bech32m', () => {
    const bytes = new Uint8Array(32).fill(0x55)
    const out = tokenIdToBech32m(bytes)
    expect(decodeTokenIdBech32m(out)).toEqual(bytes)
  })

  it('rejects a malformed `token_...` string by throwing on round-trip', () => {
    // Mutate one char in the canonical AVOW id to break the checksum.
    const bad = LGT_BECH32M.slice(0, -1) + (LGT_BECH32M.endsWith('7') ? '8' : '7')
    expect(() => tokenIdToBech32m(bad)).toThrow()
  })
})

describe('tokenIdToHex', () => {
  it('emits 64-char lowercase hex', () => {
    const bytes = new Uint8Array(32).fill(0xab)
    const hex = tokenIdToHex(bytes)
    expect(hex).toBe('ab'.repeat(32))
  })

  it('round-trips: bech32m → hex → bytes', () => {
    const fromBech32 = tokenIdToHex(LGT_BECH32M)
    expect(fromBech32).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenIdToBytes(fromBech32)).toEqual(decodeTokenIdBech32m(LGT_BECH32M))
  })
})
