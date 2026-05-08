/**
 * `@ligate/sdk` public surface.
 *
 * One barrel for the things consumers import. Add new public APIs
 * here so downstream `import { ... } from '@ligate/sdk'` keeps
 * working without churn. Keep modules feature-cohesive (keys, address,
 * borsh, transaction, client, submit) and re-export selectively here.
 *
 * Quick start:
 *
 * ```ts
 * import { generateKeypair, submitTransfer, LigateClient } from '@ligate/sdk'
 *
 * const sender = generateKeypair()
 * const client = new LigateClient({ rpcUrl: 'http://localhost:12346' })
 * const info = await client.getRollupInfo()
 * const nonce = await client.getNonce(sender.publicKey)
 *
 * const result = await submitTransfer({
 *   rpcUrl: 'http://localhost:12346',
 *   privateKey: sender.privateKeyHex,
 *   publicKey: sender.publicKey,
 *   to: 'lig1...',
 *   amountNano: 1_000_000_000n,         // 1 LGT
 *   tokenId: '<32-byte hex>',
 *   nonce,
 *   chainId: 4321n,
 *   chainHash: info.chain_hash,
 * })
 * console.log(result.txHash, result.included)
 * ```
 */

// Address utilities (bech32m `lig1...` form).
export {
  ADDRESS_HRP,
  ADDRESS_BYTE_LENGTH,
  PUBKEY_BYTE_LENGTH,
  addressBytesFromPubkey,
  addressFromPubkey,
  encodeAddress,
  decodeAddress,
} from './address.js'

// Keypair management + signing primitives.
export {
  generateKeypair,
  keypairFromPrivateKey,
  sign,
  verify,
  bytesToHex,
  hexToBytes,
} from './keys.js'
export type { Keypair } from './keys.js'

// Borsh codec (mostly internal; exported for advanced consumers
// building non-bank transactions).
export { BorshWriter } from './borsh.js'

// TokenId encoding helpers (hex ↔ bech32m ↔ Uint8Array).
export {
  TOKEN_HRP,
  TOKEN_ID_BYTE_LENGTH,
  tokenIdToBytes,
  tokenIdToBech32m,
  tokenIdToHex,
  encodeTokenIdBech32m,
  decodeTokenIdBech32m,
} from './token.js'

// Transaction builder + signer.
export { signTransfer } from './transaction.js'
export type { SignTransferParams } from './transaction.js'

// HTTP client.
export { LigateClient, appendV1, DEFAULT_MAX_FEE_NANO } from './client.js'
export type { LigateClientOptions, RollupInfo, CoinsResponse } from './client.js'

// Submit pipeline.
export { submitTransfer, submitRawTx, waitForInclusion } from './submit.js'
export type { SubmitTransferParams, SubmitRawTxOptions, SubmitResult } from './submit.js'
