/**
 * Ligate Chain `chain_hash` utilities.
 *
 * The build-time `CHAIN_HASH` is a 32-byte fingerprint of the chain's
 * compiled module set and genesis. Every signed transaction binds to
 * it (the signing payload is `borsh(UnsignedTransaction) ++ chain_hash`),
 * so a signature only verifies on the chain it was signed for.
 *
 * Since `ligate-chain@0ac7e5b` the chain serialises `chain_hash` as a
 * bech32m string with HRP `lsch` (e.g. `lsch1...`) on every
 * partner-visible surface: `GET /v1/rollup/info`, `GET /v1/rollup/schema`,
 * the chain's `ligate-node` CLI output, and the explorer. Earlier chain
 * revs emitted raw hex; the helpers in this module accept both forms
 * so SDK callers can hand whatever `getRollupInfo` returns to
 * [`signTransfer`] / [`wrapAndSign`] without a manual coercion step.
 */

import { bech32m } from '@scure/base'

import { hexToBytes } from './keys.js'

/** Human-readable prefix for chain-hash bech32m strings. */
export const CHAIN_HASH_HRP = 'lsch'

/** Length of a chain hash, in bytes. */
export const CHAIN_HASH_BYTE_LENGTH = 32

/**
 * Encode 32 raw chain-hash bytes as a `lsch1...` bech32m string.
 *
 * Throws if `bytes` is not exactly 32 bytes long.
 */
export function encodeChainHash(bytes: Uint8Array): string {
  if (bytes.length !== CHAIN_HASH_BYTE_LENGTH) {
    throw new Error(`expected ${CHAIN_HASH_BYTE_LENGTH}-byte chainHash, got ${bytes.length} bytes`)
  }
  const words = bech32m.toWords(bytes)
  return bech32m.encode(CHAIN_HASH_HRP, words, 256)
}

/**
 * Decode a `lsch1...` bech32m string into 32 raw chain-hash bytes.
 *
 * Throws on:
 * - HRP that isn't `lsch`
 * - bech32m checksum mismatch
 * - decoded byte length not 32
 */
export function decodeChainHash(s: string): Uint8Array {
  const decoded = bech32m.decode(s as `${string}1${string}`, 256)
  if (decoded.prefix !== CHAIN_HASH_HRP) {
    throw new Error(`expected '${CHAIN_HASH_HRP}' bech32m prefix, got '${decoded.prefix}' in ${s}`)
  }
  const bytes = bech32m.fromWords(decoded.words)
  if (bytes.length !== CHAIN_HASH_BYTE_LENGTH) {
    throw new Error(
      `expected ${CHAIN_HASH_BYTE_LENGTH}-byte chainHash payload, got ${bytes.length} bytes in ${s}`,
    )
  }
  return Uint8Array.from(bytes)
}

/**
 * Coerce a `chainHash` argument into 32 raw bytes.
 *
 * Accepts:
 * - `Uint8Array` of length 32 (returned verbatim)
 * - bech32m `lsch1...` string (decoded via [`decodeChainHash`]; the
 *   canonical form as of `ligate-chain@0ac7e5b`)
 * - hex string with or without a leading `0x` (64 hex chars, decoded
 *   via [`hexToBytes`]; legacy form, retained so callers reading
 *   older chain revs or replaying captured fixtures still work)
 *
 * Throws on any other shape, on the wrong HRP for bech32m inputs, on
 * a bech32m checksum mismatch, or on a payload that doesn't resolve
 * to 32 bytes.
 */
export function chainHashToBytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== CHAIN_HASH_BYTE_LENGTH) {
      throw new Error(
        `expected ${CHAIN_HASH_BYTE_LENGTH}-byte chainHash, got ${value.length} bytes`,
      )
    }
    return value
  }
  if (typeof value !== 'string') {
    throw new Error(`chainHash must be string or Uint8Array, got ${typeof value}`)
  }
  if (value.startsWith(`${CHAIN_HASH_HRP}1`)) {
    return decodeChainHash(value)
  }
  // Assume hex.
  const bytes = hexToBytes(value)
  if (bytes.length !== CHAIN_HASH_BYTE_LENGTH) {
    throw new Error(
      `expected ${CHAIN_HASH_BYTE_LENGTH}-byte chainHash from hex, got ${bytes.length} bytes`,
    )
  }
  return bytes
}
