/**
 * Token-id encoding helpers.
 *
 * The chain's `TokenId` type is a 32-byte content hash with a
 * bech32m display form using the `token_` HRP. Two examples from
 * the chain's `sov_bank` tests:
 *
 * - `token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7`
 *   (the canonical AVOW gas-token id at devnet genesis)
 * - `token_1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnfxkwm`
 *   (a deterministic test fixture, all-zero bytes)
 *
 * The transaction signing path (`signTransfer`) takes the **raw
 * 32 bytes**: borsh wants the bytes verbatim, no string encoding.
 * The HTTP query path (`LigateClient.getBalance`) takes the
 * **bech32m string**: REST URL paths use the bech32m form.
 *
 * Without these helpers the consumer has to track the same id in
 * two formats. With them, you can pass either form to either call
 * and the SDK does the right thing.
 *
 * ## HRP gotcha
 *
 * `token_` is non-standard bech32 (BIP-173 doesn't allow underscore
 * in HRPs); the chain's Rust SDK uses `bech32::Hrp::parse_unchecked`
 * to bypass that check. `@scure/base`'s bech32m happens to accept
 * underscore characters too, so we can use it directly without
 * hand-rolling. If a future `@scure/base` version tightens HRP
 * validation, we'd need to swap to a hand-rolled bech32m here.
 * The round-trip test in `test/token.test.ts` catches that drift.
 */

import { bech32m } from '@scure/base'

import { hexToBytes, bytesToHex } from './keys.js'

/** HRP for chain TokenId. Note the trailing underscore — see module docs. */
export const TOKEN_HRP = 'token_'

/** Length of a TokenId in bytes. */
export const TOKEN_ID_BYTE_LENGTH = 32

/**
 * Coerce a `TokenId` argument into raw 32 bytes.
 *
 * Accepts:
 * - 64-char lowercase or mixed-case hex string (with or without `0x` prefix)
 * - `Uint8Array` of length 32
 * - `token_1...` bech32m string
 *
 * Throws if the input doesn't match any of those shapes.
 *
 * Use this on the transaction-signing path where borsh wants the
 * raw bytes; [`signTransfer`] calls it internally on the `tokenId`
 * argument.
 */
export function tokenIdToBytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== TOKEN_ID_BYTE_LENGTH) {
      throw new Error(`expected ${TOKEN_ID_BYTE_LENGTH}-byte tokenId, got ${value.length}`)
    }
    return value
  }
  if (typeof value !== 'string') {
    throw new Error(`tokenId must be string or Uint8Array, got ${typeof value}`)
  }
  if (value.startsWith(TOKEN_HRP)) {
    return decodeTokenIdBech32m(value)
  }
  // Assume hex.
  const bytes = hexToBytes(value)
  if (bytes.length !== TOKEN_ID_BYTE_LENGTH) {
    throw new Error(
      `expected ${TOKEN_ID_BYTE_LENGTH}-byte tokenId, got ${bytes.length} bytes from hex`,
    )
  }
  return bytes
}

/**
 * Coerce a `TokenId` argument into the bech32m `token_1...` string form.
 *
 * Accepts the same shapes as [`tokenIdToBytes`]; useful on the HTTP
 * query path where the chain's REST URLs need the bech32m form.
 * [`LigateClient.getBalance`] calls this internally on its `tokenId`
 * argument.
 */
export function tokenIdToBech32m(value: string | Uint8Array): string {
  if (typeof value === 'string' && value.startsWith(TOKEN_HRP)) {
    // Validate the round-trip so callers get an early error on a typo.
    decodeTokenIdBech32m(value)
    return value
  }
  const bytes = tokenIdToBytes(value)
  return encodeTokenIdBech32m(bytes)
}

/** Encode 32 raw bytes as a `token_1...` bech32m string. */
export function encodeTokenIdBech32m(bytes: Uint8Array): string {
  if (bytes.length !== TOKEN_ID_BYTE_LENGTH) {
    throw new Error(`expected ${TOKEN_ID_BYTE_LENGTH}-byte tokenId, got ${bytes.length}`)
  }
  return bech32m.encode(TOKEN_HRP, bech32m.toWords(bytes))
}

/** Decode a `token_1...` bech32m string into 32 raw bytes. */
export function decodeTokenIdBech32m(s: string): Uint8Array {
  const decoded = bech32m.decode(s as `${string}1${string}`)
  if (decoded.prefix !== TOKEN_HRP) {
    throw new Error(`expected '${TOKEN_HRP}' bech32m prefix, got '${decoded.prefix}' in ${s}`)
  }
  const bytes = bech32m.fromWords(decoded.words)
  if (bytes.length !== TOKEN_ID_BYTE_LENGTH) {
    throw new Error(
      `expected ${TOKEN_ID_BYTE_LENGTH}-byte tokenId payload, got ${bytes.length} in ${s}`,
    )
  }
  return Uint8Array.from(bytes)
}

/** Convenience: 64-char hex of a TokenId in any input form. */
export function tokenIdToHex(value: string | Uint8Array): string {
  return bytesToHex(tokenIdToBytes(value))
}
