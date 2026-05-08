/**
 * Ligate Chain address utilities.
 *
 * Addresses are 28-byte values encoded as bech32m strings with the
 * `lig` HRP (e.g. `lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u`).
 *
 * The 28 bytes are derived from a 32-byte Ed25519 public key by
 * taking the first 28 bytes (`pubkey[..28]`). This matches the
 * chain's authentication flow (see `Address::from(HexString<[u8;32]>)`
 * in the Sovereign SDK and the chain repo's `genesis-tool`).
 *
 * **Do NOT use SHA-256(pubkey)[..28].** That's how the chain's
 * `crates/stf/tests/devnet_addresses.rs` derives genesis-stub
 * addresses from string labels (e.g. "ligate-devnet-bootstrap"); it
 * is NOT how a keypair-derived address is computed at signature-
 * verification time. Using the wrong derivation produces an address
 * the chain can't match against the signing pubkey, leading to
 * `CannotReserveGas("Insufficient balance")` errors at execute time.
 * (See ligate-chain#245 for the bug + fix history on the Rust side.)
 */

import { bech32m } from '@scure/base'

/** Human-readable prefix for chain addresses. */
export const ADDRESS_HRP = 'lig'

/** Length of a chain address, in bytes. */
export const ADDRESS_BYTE_LENGTH = 28

/** Length of an Ed25519 public key, in bytes. */
export const PUBKEY_BYTE_LENGTH = 32

/**
 * Derive the 28-byte address bytes from a 32-byte Ed25519 public key.
 *
 * Takes the first 28 bytes of the public key. The `pubkey[..28]`
 * derivation matches `From<HexString<[u8;32]>> for Address` in
 * `sov-modules-api`'s `common::address` module.
 */
export function addressBytesFromPubkey(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length !== PUBKEY_BYTE_LENGTH) {
    throw new Error(`expected ${PUBKEY_BYTE_LENGTH}-byte public key, got ${pubkey.length} bytes`)
  }
  return pubkey.slice(0, ADDRESS_BYTE_LENGTH)
}

/**
 * Encode 28 raw address bytes as a `lig1...` bech32m string.
 *
 * Throws if `bytes` is not exactly 28 bytes long.
 */
export function encodeAddress(bytes: Uint8Array): string {
  if (bytes.length !== ADDRESS_BYTE_LENGTH) {
    throw new Error(`expected ${ADDRESS_BYTE_LENGTH}-byte address, got ${bytes.length} bytes`)
  }
  // bech32m's encode signature: encode(prefix, words, limit?). The
  // words are the 5-bit-grouped representation of the bytes.
  const words = bech32m.toWords(bytes)
  return bech32m.encode(ADDRESS_HRP, words)
}

/**
 * Decode a `lig1...` bech32m string into 28 raw address bytes.
 *
 * Throws on:
 * - HRP that isn't `lig`
 * - bech32m checksum mismatch
 * - decoded byte length not 28
 */
export function decodeAddress(addr: string): Uint8Array {
  const decoded = bech32m.decode(addr as `${string}1${string}`)
  if (decoded.prefix !== ADDRESS_HRP) {
    throw new Error(`expected '${ADDRESS_HRP}' bech32m prefix, got '${decoded.prefix}' in ${addr}`)
  }
  const bytes = bech32m.fromWords(decoded.words)
  if (bytes.length !== ADDRESS_BYTE_LENGTH) {
    throw new Error(
      `expected ${ADDRESS_BYTE_LENGTH}-byte address payload, got ${bytes.length} bytes in ${addr}`,
    )
  }
  return Uint8Array.from(bytes)
}

/**
 * Derive a `lig1...` address string from an Ed25519 public key.
 *
 * Convenience wrapper for [`addressBytesFromPubkey`] +
 * [`encodeAddress`].
 */
export function addressFromPubkey(pubkey: Uint8Array): string {
  return encodeAddress(addressBytesFromPubkey(pubkey))
}
