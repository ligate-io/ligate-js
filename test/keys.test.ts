/**
 * Ed25519 keypair management + signing tests.
 *
 * The chain's localnet dev key (private `0x01...01`) gives us a fixed
 * test vector for both pubkey derivation and address derivation. If
 * this drifts, signed txs will be rejected by the chain — pin it
 * here so we catch the drift in CI, not at devnet boot.
 */

import { describe, expect, it } from 'vitest'

import {
  bytesToHex,
  generateKeypair,
  hexToBytes,
  keypairFromPrivateKey,
  sign,
  verify,
} from '../src/keys.js'

const DEV_PRIVATE_KEY = '01'.repeat(32)
const DEV_PUBLIC_KEY_HEX = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c'
const DEV_ADDRESS = 'lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u'

describe('keypairFromPrivateKey', () => {
  it('produces the expected dev pubkey + address from the canonical seed', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    expect(bytesToHex(kp.publicKey)).toBe(DEV_PUBLIC_KEY_HEX)
    expect(kp.address).toBe(DEV_ADDRESS)
    expect(kp.privateKeyHex).toBe(DEV_PRIVATE_KEY)
  })

  it('accepts both string and Uint8Array seeds', () => {
    const fromHex = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    const fromBytes = keypairFromPrivateKey(hexToBytes(DEV_PRIVATE_KEY))
    expect(fromBytes.publicKey).toEqual(fromHex.publicKey)
    expect(fromBytes.address).toBe(fromHex.address)
  })

  it('rejects non-32-byte seeds', () => {
    expect(() => keypairFromPrivateKey('00'.repeat(31))).toThrow()
    expect(() => keypairFromPrivateKey('00'.repeat(33))).toThrow()
  })
})

describe('generateKeypair', () => {
  it('returns a 32-byte pubkey + bech32m address', () => {
    const kp = generateKeypair()
    expect(kp.publicKey).toHaveLength(32)
    expect(kp.privateKeyHex).toHaveLength(64)
    expect(kp.address.startsWith('lig1')).toBe(true)
  })

  it('produces different keypairs on successive calls', () => {
    const a = generateKeypair()
    const b = generateKeypair()
    expect(a.privateKeyHex).not.toBe(b.privateKeyHex)
  })
})

describe('sign / verify', () => {
  it('round-trips a signature', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    const message = new TextEncoder().encode('hello ligate')
    const signature = sign(message, kp.privateKeyHex)
    expect(signature).toHaveLength(64)
    expect(verify(signature, message, kp.publicKey)).toBe(true)
  })

  it('rejects a signature on a tampered message', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    const message = new TextEncoder().encode('hello ligate')
    const signature = sign(message, kp.privateKeyHex)
    const tampered = new TextEncoder().encode('hello attacker')
    expect(verify(signature, tampered, kp.publicKey)).toBe(false)
  })
})

describe('hex helpers', () => {
  it('round-trips bytes ↔ hex', () => {
    const bytes = new Uint8Array([0x00, 0x0a, 0xff, 0x42])
    expect(bytesToHex(bytes)).toBe('000aff42')
    expect(hexToBytes('000aff42')).toEqual(bytes)
  })

  it('tolerates a `0x` prefix', () => {
    expect(hexToBytes('0x000aff42')).toEqual(new Uint8Array([0x00, 0x0a, 0xff, 0x42]))
  })

  it('rejects odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow()
  })

  it('rejects invalid hex chars', () => {
    expect(() => hexToBytes('zz')).toThrow()
  })
})
