/**
 * Address-derivation + bech32m round-trip tests.
 *
 * Anchor: the chain's localnet dev key
 * (`devnet/local-dev-key.json`, ligate-chain#247) has private-key seed
 * `0x0101...01` and address
 * `lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u`. If this
 * test ever drifts from that value, either the chain regenerated its
 * dev key (and these tests need updating) OR the JS-side derivation
 * silently broke (and we'd produce txs the chain can't authenticate).
 * The whole point of this file is to make the second case impossible
 * to merge.
 */

import { describe, expect, it } from 'vitest'

import { bech32m } from '@scure/base'
import {
  addressBytesFromPubkey,
  addressFromPubkey,
  decodeAddress,
  encodeAddress,
} from '../src/address.js'
import { keypairFromPrivateKey } from '../src/keys.js'

describe('addressBytesFromPubkey', () => {
  it('takes the first 28 bytes of the 32-byte pubkey', () => {
    const pubkey = new Uint8Array(32)
    for (let i = 0; i < 32; i++) pubkey[i] = i
    const addr = addressBytesFromPubkey(pubkey)
    expect(addr).toHaveLength(28)
    for (let i = 0; i < 28; i++) {
      expect(addr[i]).toBe(i)
    }
  })

  it('rejects non-32-byte input', () => {
    expect(() => addressBytesFromPubkey(new Uint8Array(31))).toThrow()
    expect(() => addressBytesFromPubkey(new Uint8Array(33))).toThrow()
  })
})

describe('encodeAddress / decodeAddress', () => {
  it('round-trips through bech32m', () => {
    const original = new Uint8Array(28)
    for (let i = 0; i < 28; i++) original[i] = i + 1
    const encoded = encodeAddress(original)
    expect(encoded.startsWith('lig1')).toBe(true)
    const decoded = decodeAddress(encoded)
    expect(decoded).toEqual(original)
  })

  it('rejects non-`lig` HRP', () => {
    // Build a checksum-valid bech32m with a different HRP, so the
    // failure path we hit is the HRP check (not checksum validation).
    const fakeAddress = bech32m.encode('cosmos', bech32m.toWords(new Uint8Array(28)))
    expect(() => decodeAddress(fakeAddress)).toThrow(/lig|prefix/)
  })

  it('rejects bad checksum', () => {
    // Flip the last char (within bech32m alphabet).
    const good = encodeAddress(new Uint8Array(28))
    const bad = good.slice(0, -1) + (good.endsWith('q') ? 'p' : 'q')
    expect(() => decodeAddress(bad)).toThrow()
  })
})

describe('localnet dev key (chain #247)', () => {
  // Deterministic seed used by `devnet/local-dev-key.json`. Pre-funded
  // with 10000 AVOW in the localnet genesis.
  const DEV_PRIVATE_KEY = '01'.repeat(32)
  const EXPECTED_ADDRESS = 'lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u'

  it('derives the chain-side address bit-for-bit', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    expect(kp.address).toBe(EXPECTED_ADDRESS)
  })

  it('addressFromPubkey matches the keypair address', () => {
    const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)
    expect(addressFromPubkey(kp.publicKey)).toBe(EXPECTED_ADDRESS)
  })
})
