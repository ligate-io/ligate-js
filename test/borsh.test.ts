/**
 * Borsh codec tests.
 *
 * The chain reads transactions with `borsh::to_vec` round-trippability
 * (deterministic, no padding); these tests pin the byte-level
 * little-endian layout so we catch any accidental drift from
 * https://borsh.io/.
 */

import { describe, expect, it } from 'vitest'

import { BorshWriter } from '../src/borsh.js'

describe('BorshWriter', () => {
  it('writes u8 as one byte', () => {
    const w = new BorshWriter()
    w.writeU8(0x42)
    expect(w.bytes()).toEqual(new Uint8Array([0x42]))
  })

  it('writes u32 little-endian', () => {
    const w = new BorshWriter()
    w.writeU32(0x01020304)
    expect(w.bytes()).toEqual(new Uint8Array([0x04, 0x03, 0x02, 0x01]))
  })

  it('writes u64 little-endian', () => {
    const w = new BorshWriter()
    w.writeU64(0x0102030405060708n)
    expect(w.bytes()).toEqual(new Uint8Array([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]))
  })

  it('writes u128 little-endian', () => {
    const w = new BorshWriter()
    w.writeU128(1n)
    const out = w.bytes()
    expect(out).toHaveLength(16)
    expect(out[0]).toBe(1)
    for (let i = 1; i < 16; i++) {
      expect(out[i]).toBe(0)
    }
  })

  it('writes u128 max correctly', () => {
    const w = new BorshWriter()
    w.writeU128((1n << 128n) - 1n)
    const out = w.bytes()
    expect(out).toHaveLength(16)
    for (let i = 0; i < 16; i++) {
      expect(out[i]).toBe(0xff)
    }
  })

  it('rejects out-of-range numerics', () => {
    expect(() => new BorshWriter().writeU32(-1)).toThrow()
    expect(() => new BorshWriter().writeU32(0x1_00000000)).toThrow()
    expect(() => new BorshWriter().writeU64(-1n)).toThrow()
    expect(() => new BorshWriter().writeU64(1n << 64n)).toThrow()
    expect(() => new BorshWriter().writeU128(-1n)).toThrow()
    expect(() => new BorshWriter().writeU128(1n << 128n)).toThrow()
  })

  it('writeVecU8 prepends a u32 LE length', () => {
    const w = new BorshWriter()
    w.writeVecU8(new Uint8Array([0xaa, 0xbb, 0xcc]))
    expect(w.bytes()).toEqual(new Uint8Array([0x03, 0x00, 0x00, 0x00, 0xaa, 0xbb, 0xcc]))
  })

  it('writeOptionTag writes 0 for None and 1 for Some', () => {
    const none = new BorshWriter()
    none.writeOptionTag(false)
    expect(none.bytes()).toEqual(new Uint8Array([0]))

    const some = new BorshWriter()
    some.writeOptionTag(true)
    expect(some.bytes()).toEqual(new Uint8Array([1]))
  })

  it('writeFixedBytes emits raw bytes (no length prefix)', () => {
    const w = new BorshWriter()
    w.writeFixedBytes(new Uint8Array([1, 2, 3, 4]), 4)
    expect(w.bytes()).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('writeFixedBytes rejects wrong-length input', () => {
    const w = new BorshWriter()
    expect(() => w.writeFixedBytes(new Uint8Array([1, 2, 3]), 4)).toThrow()
  })
})
