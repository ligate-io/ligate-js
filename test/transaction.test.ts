/**
 * `signTransfer` shape tests.
 *
 * We can't easily verify the exact bytes match the chain's borsh
 * encoding without mirroring the chain's encoder in TS (which is what
 * `transaction.ts` IS), but we can verify:
 *
 * - The output starts with the correct discriminants
 * - The signature + pubkey appear at the right offsets
 * - The body is structured correctly (RuntimeCall + Uniqueness + TxDetails)
 * - The signature actually verifies against `borsh(unsigned) ++ chain_hash`
 *
 * The end-to-end check happens in `e2e/` against a running localnet.
 */

import { describe, expect, it } from 'vitest'

import { decodeAddress } from '../src/address.js'
import { encodeChainHash } from '../src/chainHash.js'
import { keypairFromPrivateKey, verify } from '../src/keys.js'
import { signTransfer } from '../src/transaction.js'

const DEV_PRIVATE_KEY = '01'.repeat(32)
const DUMMY_TO = 'lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u'
const DUMMY_TOKEN = 'aa'.repeat(32)
const DUMMY_CHAIN_HASH = 'bb'.repeat(32)
const DUMMY_CHAIN_HASH_BECH32M = encodeChainHash(new Uint8Array(32).fill(0xbb))

describe('signTransfer', () => {
  const kp = keypairFromPrivateKey(DEV_PRIVATE_KEY)

  it('produces bytes starting with the V0 discriminant', () => {
    const out = signTransfer({
      privateKey: kp.privateKeyHex,
      publicKey: kp.publicKey,
      to: DUMMY_TO,
      amountNano: 1_000_000_000n,
      tokenId: DUMMY_TOKEN,
      nonce: 0n,
      chainId: 4242n,
      chainHash: DUMMY_CHAIN_HASH,
    })
    // Transaction::V0 discriminant
    expect(out[0]).toBe(0x00)
    // Signature: 64 bytes at offset 1..65
    expect(out.length).toBeGreaterThan(1 + 64 + 32)
    // Pubkey: 32 bytes at offset 65..97
    const embeddedPubkey = out.slice(1 + 64, 1 + 64 + 32)
    expect(embeddedPubkey).toEqual(kp.publicKey)
  })

  it('embeds the bank.transfer call discriminants in the body', () => {
    const out = signTransfer({
      privateKey: kp.privateKeyHex,
      publicKey: kp.publicKey,
      to: DUMMY_TO,
      amountNano: 1n,
      tokenId: DUMMY_TOKEN,
      nonce: 0n,
      chainId: 1n,
      chainHash: DUMMY_CHAIN_HASH,
    })
    // Body starts at offset 1 + 64 + 32 = 97.
    const body = out.slice(1 + 64 + 32)
    // RuntimeCall::Bank discriminant (0x00).
    expect(body[0]).toBe(0x00)
    // BankCall::Transfer discriminant (0x01).
    expect(body[1]).toBe(0x01)
    // MultiAddress::Standard discriminant (0x00).
    expect(body[2]).toBe(0x00)
    // Then 28 address bytes — verify against the bech32m decode.
    const toBytes = decodeAddress(DUMMY_TO)
    for (let i = 0; i < 28; i++) {
      expect(body[3 + i]).toBe(toBytes[i])
    }
  })

  it('produces a signature that verifies against borsh(unsigned) ++ chain_hash', () => {
    const out = signTransfer({
      privateKey: kp.privateKeyHex,
      publicKey: kp.publicKey,
      to: DUMMY_TO,
      amountNano: 42n,
      tokenId: DUMMY_TOKEN,
      nonce: 7n,
      chainId: 4242n,
      chainHash: DUMMY_CHAIN_HASH,
    })

    // Signature is bytes [1..65); pubkey [65..97); body is the rest.
    const signature = out.slice(1, 1 + 64)
    const body = out.slice(1 + 64 + 32)

    // The chain signs `borsh(unsigned) ++ chain_hash`. The body in the
    // V0 wrapper IS the borsh-encoded UnsignedTransaction, since
    // Version0's signed-fields layout starts with the unsigned body
    // (runtime_call + uniqueness + details).
    const chainHashBytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) chainHashBytes[i] = 0xbb
    const message = new Uint8Array(body.length + 32)
    message.set(body, 0)
    message.set(chainHashBytes, body.length)

    expect(verify(signature, message, kp.publicKey)).toBe(true)
  })

  it('accepts a bech32m `lsch1...` chainHash and produces identical bytes to hex', () => {
    const base = {
      privateKey: kp.privateKeyHex,
      publicKey: kp.publicKey,
      to: DUMMY_TO,
      amountNano: 42n,
      tokenId: DUMMY_TOKEN,
      nonce: 7n,
      chainId: 4242n,
    }
    const fromHex = signTransfer({ ...base, chainHash: DUMMY_CHAIN_HASH })
    const fromBech32m = signTransfer({ ...base, chainHash: DUMMY_CHAIN_HASH_BECH32M })
    expect(fromBech32m).toEqual(fromHex)
  })

  it('rejects wrong-length inputs', () => {
    const base = {
      privateKey: kp.privateKeyHex,
      publicKey: kp.publicKey,
      to: DUMMY_TO,
      amountNano: 1n,
      tokenId: DUMMY_TOKEN,
      nonce: 0n,
      chainId: 1n,
      chainHash: DUMMY_CHAIN_HASH,
    }
    expect(() => signTransfer({ ...base, publicKey: new Uint8Array(31) })).toThrow(/publicKey/)
    expect(() => signTransfer({ ...base, tokenId: 'aa' })).toThrow(/tokenId/)
    expect(() => signTransfer({ ...base, chainHash: 'bb' })).toThrow(/chainHash/)
  })
})
