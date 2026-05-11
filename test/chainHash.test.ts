/**
 * `chainHash` coercion + roundtrip tests.
 */

import { describe, expect, it } from 'vitest'

import {
  CHAIN_HASH_BYTE_LENGTH,
  CHAIN_HASH_HRP,
  chainHashToBytes,
  decodeChainHash,
  encodeChainHash,
} from '../src/chainHash.js'

describe('encodeChainHash / decodeChainHash', () => {
  it('roundtrips arbitrary 32-byte payloads', () => {
    const bytes = new Uint8Array(CHAIN_HASH_BYTE_LENGTH)
    for (let i = 0; i < CHAIN_HASH_BYTE_LENGTH; i++) bytes[i] = (i * 7 + 3) & 0xff
    const encoded = encodeChainHash(bytes)
    expect(encoded.startsWith(`${CHAIN_HASH_HRP}1`)).toBe(true)
    const decoded = decodeChainHash(encoded)
    expect(decoded).toEqual(bytes)
  })

  it('rejects wrong-length payloads on encode', () => {
    expect(() => encodeChainHash(new Uint8Array(31))).toThrow(/32-byte chainHash/)
    expect(() => encodeChainHash(new Uint8Array(33))).toThrow(/32-byte chainHash/)
  })

  it('rejects wrong HRP on decode', () => {
    expect(() =>
      decodeChainHash('lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u'),
    ).toThrow(/'lsch' bech32m prefix/)
  })

  it('rejects bech32m checksum mismatch', () => {
    const bytes = new Uint8Array(CHAIN_HASH_BYTE_LENGTH).fill(0xbb)
    const good = encodeChainHash(bytes)
    // Flip one char in the data portion to corrupt the checksum.
    const bad = good.slice(0, -1) + (good.endsWith('q') ? 'p' : 'q')
    expect(() => decodeChainHash(bad)).toThrow()
  })
})

describe('chainHashToBytes', () => {
  const bytes = new Uint8Array(CHAIN_HASH_BYTE_LENGTH).fill(0xbb)
  const hexNoPrefix = 'bb'.repeat(CHAIN_HASH_BYTE_LENGTH)
  const hexWithPrefix = `0x${hexNoPrefix}`
  const bech32m = encodeChainHash(bytes)

  it('passes through a Uint8Array(32) verbatim', () => {
    expect(chainHashToBytes(bytes)).toEqual(bytes)
  })

  it('decodes a 64-char hex string', () => {
    expect(chainHashToBytes(hexNoPrefix)).toEqual(bytes)
  })

  it('decodes a hex string with leading 0x', () => {
    expect(chainHashToBytes(hexWithPrefix)).toEqual(bytes)
  })

  it('decodes a bech32m `lsch1...` string', () => {
    expect(chainHashToBytes(bech32m)).toEqual(bytes)
  })

  it('rejects a Uint8Array of the wrong length', () => {
    expect(() => chainHashToBytes(new Uint8Array(31))).toThrow(/32-byte chainHash/)
  })

  it('rejects hex of the wrong length', () => {
    expect(() => chainHashToBytes('aa'.repeat(31))).toThrow(/32-byte chainHash from hex/)
  })

  it('rejects garbage with a valid `lsch1` prefix (checksum failure)', () => {
    // Starts with the right HRP but the payload is invalid bech32m.
    expect(() => chainHashToBytes('lsch1abcdefg')).toThrow()
  })

  it('rejects non-string non-Uint8Array values', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => chainHashToBytes(42 as any)).toThrow(/string or Uint8Array/)
  })
})
