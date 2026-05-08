/**
 * Ed25519 keypair management.
 *
 * Mirrors the Rust `ligate-cli`'s `keys` module: generate a 32-byte
 * private key (CSPRNG seed), derive the corresponding public key,
 * derive the 28-byte chain address from the public key.
 *
 * Uses `@noble/ed25519` for the underlying crypto: zero-deps,
 * audited, runs in browser + Node without polyfills.
 */

import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'

import { addressFromPubkey } from './address.js'

// `@noble/ed25519` v2 requires a SHA-512 implementation be wired in
// as a sync function for the synchronous helpers (and it's needed by
// the async ones too on browsers without WebCrypto SHA-512). Wire
// `@noble/hashes`'s SHA-512.
ed25519.etc.sha512Sync = (...messages) => sha512(ed25519.etc.concatBytes(...messages))

/** A locally-generated Ed25519 signing keypair plus its derived address. */
export interface Keypair {
  /** 32-byte private key seed. Hex-encoded for storage. */
  privateKeyHex: string
  /** 32 bytes. */
  publicKey: Uint8Array
  /** Bech32m `lig1...` form, derived as `pubkey[..28]`. */
  address: string
}

/**
 * Generate a fresh Ed25519 keypair from CSPRNG entropy.
 *
 * Equivalent to `ligate keys generate` in the Rust cli (see
 * `ligate-cli/src/keys.rs::generate_role`). The address derivation
 * matches: `pubkey[..28]` bech32m-encoded with the `lig` HRP.
 */
export function generateKeypair(): Keypair {
  // `randomPrivateKey` returns 32 bytes from CSPRNG (`crypto.getRandomValues`
  // in browsers, `crypto.randomBytes` equivalent in Node).
  const privateKey = ed25519.utils.randomPrivateKey()
  return keypairFromPrivateKey(privateKey)
}

/**
 * Reconstruct a keypair from a 32-byte private key seed.
 *
 * Useful for loading a key from disk or env (e.g., the localnet
 * dev key shipped at `devnet/local-dev-key.json` in the chain repo).
 */
export function keypairFromPrivateKey(privateKey: Uint8Array | string): Keypair {
  const sk = typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey
  if (sk.length !== 32) {
    throw new Error(`expected 32-byte private key, got ${sk.length} bytes`)
  }
  const publicKey = ed25519.getPublicKey(sk)
  return {
    privateKeyHex: bytesToHex(sk),
    publicKey,
    address: addressFromPubkey(publicKey),
  }
}

/**
 * Sign a message with a 32-byte private key. Returns a 64-byte
 * Ed25519 signature.
 */
export function sign(message: Uint8Array, privateKey: Uint8Array | string): Uint8Array {
  const sk = typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey
  if (sk.length !== 32) {
    throw new Error(`expected 32-byte private key, got ${sk.length} bytes`)
  }
  return ed25519.sign(message, sk)
}

/**
 * Verify a 64-byte Ed25519 signature against a message + 32-byte
 * public key.
 */
export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  return ed25519.verify(signature, message, publicKey)
}

/** Encode bytes as a lowercase hex string (no `0x` prefix). */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Decode a lowercase or mixed-case hex string into bytes. Tolerates `0x` prefix. */
export function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex
  if (stripped.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${hex}`)
  }
  const out = new Uint8Array(stripped.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(stripped.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex at offset ${i * 2}: ${hex}`)
    }
    out[i] = byte
  }
  return out
}
