/**
 * Borsh-encoded `Transaction::V0(Version0)` for the chain's
 * `bank.transfer` flow.
 *
 * ## Wire format
 *
 * The chain's `Transaction` enum is serialised with a 1-byte
 * discriminant followed by the variant payload:
 *
 * ```
 * Transaction::V0(Version0)
 *   discriminant = 0x00
 *   Version0 fields, in declaration order:
 *     signature       64 bytes (Ed25519 signature, raw)
 *     pub_key         32 bytes (Ed25519 public key, raw)
 *     runtime_call    RuntimeCall<S> (enum + variant payload)
 *     uniqueness      UniquenessData (enum + variant payload)
 *     details         TxDetails (struct)
 *
 * RuntimeCall::Bank(BankCall) = 0x00
 *   BankCall::Transfer { to, coins } = 0x01
 *     to: MultiAddress::Standard(28-byte address) = 0x00 + 28 bytes
 *     coins:
 *       amount: u128 LE  (16 bytes)
 *       token_id: 32 bytes raw
 *
 * UniquenessData::Nonce(u64) = 0x00 + 8 bytes LE
 *
 * TxDetails:
 *   max_priority_fee_bips: u64 LE (8 bytes)
 *   max_fee: u128 LE (16 bytes)
 *   gas_limit: Option<Gas>
 *     None = 0x00 (no payload)
 *     Some = 0x01 + 16 bytes (Gas = 2x u64 LE)
 *   chain_id: u64 LE (8 bytes)
 * ```
 *
 * ## Signing
 *
 * The chain signs `borsh(UnsignedTransaction) ++ chain_hash`:
 *
 * ```
 * UnsignedTransaction (struct):
 *   runtime_call
 *   uniqueness
 *   details
 * ```
 *
 * Then wraps in Version0 with the resulting signature + pub_key.
 *
 * ## Don't pre-wrap
 *
 * The bytes returned by [`signTransfer`] are the borsh-encoded
 * `Transaction::V0(...)`, NOT the `AuthenticatorInput::Standard(...)`
 * outer wrapping. The chain's `POST /v1/sequencer/txs` handler wraps
 * the body server-side. Pre-wrapping double-wraps and the chain
 * rejects with `Cannot decompress Edwards point`. See
 * [`ligate-chain#245`](https://github.com/ligate-io/ligate-chain/issues/245).
 */

import { decodeAddress } from './address.js'
import { BorshWriter } from './borsh.js'
import { hexToBytes, sign } from './keys.js'

/** Discriminant for `Transaction::V0`. */
const TX_V0_DISC = 0x00

/** Discriminant for `RuntimeCall::Bank` in the chain's runtime composition. */
const RUNTIME_BANK_DISC = 0x00

/** Discriminant for `BankCall::Transfer`. */
const BANK_TRANSFER_DISC = 0x01

/** Discriminant for `MultiAddress::Standard(Address)`. */
const ADDR_STANDARD_DISC = 0x00

/** Discriminant for `UniquenessData::Nonce(u64)`. */
const UNIQUENESS_NONCE_DISC = 0x00

/** Inputs needed to build + sign a `bank.transfer` transaction. */
export interface SignTransferParams {
  /** 32-byte private key seed (hex string or raw bytes). */
  privateKey: string | Uint8Array
  /** 32-byte public key for the signer. Must correspond to `privateKey`. */
  publicKey: Uint8Array
  /** Recipient `lig1...` bech32m address. */
  to: string
  /** Transfer amount in nano-LGT. */
  amountNano: bigint
  /** Token id, 32 bytes raw (hex string or `Uint8Array`). */
  tokenId: string | Uint8Array
  /** Account nonce. Fetch from `GET /v1/modules/.../nonces` or maintain locally. */
  nonce: bigint
  /** Numeric chain id (u64). Pulled from chain `constants.toml`. */
  chainId: bigint
  /** 32-byte chain hash (hex string or `Uint8Array`). From `GET /v1/rollup/info`. */
  chainHash: string | Uint8Array
  /** Max fee budget in nano-LGT. Defaults to 100_000_000 (0.1 LGT). */
  maxFeeNano?: bigint
  /** Priority-fee bips. Defaults to 0. */
  maxPriorityFeeBips?: bigint
}

/**
 * Build, sign, and borsh-encode a `bank.transfer` transaction.
 *
 * Returns the bytes ready to base64-encode and POST to
 * `/v1/sequencer/txs`. The server wraps in
 * `AuthenticatorInput::Standard(...)` itself; do not pre-wrap.
 */
export function signTransfer(params: SignTransferParams): Uint8Array {
  const { privateKey, publicKey, to, amountNano, nonce, chainId } = params
  const tokenId = bytesArg(params.tokenId, 32, 'tokenId')
  const chainHash = bytesArg(params.chainHash, 32, 'chainHash')
  const maxFeeNano = params.maxFeeNano ?? 100_000_000n
  const maxPriorityFeeBips = params.maxPriorityFeeBips ?? 0n

  if (publicKey.length !== 32) {
    throw new Error(`expected 32-byte publicKey, got ${publicKey.length}`)
  }

  // ---- Build the unsigned-transaction body ----
  // (runtime_call + uniqueness + details, in that order)

  const body = new BorshWriter()

  // RuntimeCall::Bank(BankCall::Transfer { to, coins }):
  body.writeU8(RUNTIME_BANK_DISC)
  body.writeU8(BANK_TRANSFER_DISC)
  // to: MultiAddress::Standard(28-byte address)
  const toBytes = decodeAddress(to)
  body.writeU8(ADDR_STANDARD_DISC)
  body.writeFixedBytes(toBytes, 28)
  // coins:
  //   amount: u128 LE
  body.writeU128(amountNano)
  //   token_id: 32 bytes raw
  body.writeFixedBytes(tokenId, 32)

  // UniquenessData::Nonce(u64):
  body.writeU8(UNIQUENESS_NONCE_DISC)
  body.writeU64(nonce)

  // TxDetails { max_priority_fee_bips, max_fee, gas_limit, chain_id }:
  body.writeU64(maxPriorityFeeBips)
  body.writeU128(maxFeeNano)
  // gas_limit: Option<Gas>. We always pass None for now (chain default).
  body.writeOptionTag(false)
  body.writeU64(chainId)

  const bodyBytes = body.bytes()

  // ---- Sign over `body || chain_hash` ----
  const message = new Uint8Array(bodyBytes.length + 32)
  message.set(bodyBytes, 0)
  message.set(chainHash, bodyBytes.length)
  const signature = sign(message, privateKey)
  if (signature.length !== 64) {
    throw new Error(`expected 64-byte signature, got ${signature.length}`)
  }

  // ---- Wrap in Transaction::V0 ----
  // Note: signature + pub_key come BEFORE the body fields in
  // Version0's struct order.
  const out = new BorshWriter()
  out.writeU8(TX_V0_DISC)
  out.writeFixedBytes(signature, 64)
  out.writeFixedBytes(publicKey, 32)
  out.writeBytes(bodyBytes)
  return out.bytes()
}

/** Coerce a `string | Uint8Array` argument to `Uint8Array` of an exact length. */
function bytesArg(value: string | Uint8Array, expectedLen: number, name: string): Uint8Array {
  const bytes = typeof value === 'string' ? hexToBytes(value) : value
  if (bytes.length !== expectedLen) {
    throw new Error(`expected ${expectedLen}-byte ${name}, got ${bytes.length}`)
  }
  return bytes
}
