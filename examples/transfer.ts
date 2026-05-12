#!/usr/bin/env -S node --import tsx
/**
 * Example: build, sign, and submit a transfer on Ligate Chain.
 *
 * Demonstrates the build-sign-submit flow against a running localnet
 * (the same one `e2e/transfer.e2e.test.ts` uses). Loads a sender key
 * from a JSON file (or uses the chain's well-known dev key by
 * default), submits a transfer to a recipient, and watches for
 * inclusion.
 *
 * ## Usage
 *
 * ```sh
 * # Boot the chain first (see ligate-chain/devnet/README.md):
 * #   cd ~/Desktop/ligate-chain && cargo run --bin ligate-node
 *
 * # Then from this repo:
 * pnpm tsx examples/transfer.ts \
 *     --to lig1u8z2rxh6ymjwkqsasme64f5kfphtfm2kf4kkn0clusfpr34amezsp5j7yp \
 *     --amount 1
 * ```
 *
 * `--from FILE` (optional): JSON keypair as written by
 * `examples/generate-keypair.ts --out`. If omitted, uses the
 * localnet dev key (32 bytes of `0x01`, pre-funded with 10000 LGT in
 * `ligate-chain/devnet/genesis/bank.json`).
 *
 * ## Environment
 *
 * | Var | Default | What |
 * |---|---|---|
 * | `LIGATE_RPC` | `http://localhost:12346` | Chain RPC URL |
 * | `LIGATE_CHAIN_ID` | `4242` | Numeric `CHAIN_ID` (see `constants.toml`) |
 * | `LIGATE_TOKEN_ID` | localnet $LGT bech32m | Token id to transfer |
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { keypairFromPrivateKey, LigateClient, submitTransfer } from '../src/index.js'

// Localnet dev key constants (per `ligate-chain/devnet/local-dev-key.json`).
const DEV_KEY_HEX = '0101010101010101010101010101010101010101010101010101010101010101'

// Localnet $LGT token id from `ligate-chain/devnet/genesis/bank.json`.
const DEFAULT_TOKEN_ID = 'token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7'

const RPC_URL = process.env.LIGATE_RPC || 'http://localhost:12346'
const CHAIN_ID = BigInt(process.env.LIGATE_CHAIN_ID || '4242')
const TOKEN_ID = process.env.LIGATE_TOKEN_ID || DEFAULT_TOKEN_ID

interface Args {
  from: string | null
  to: string
  amountLgt: number
}

function parseArgs(argv: string[]): Args {
  let from: string | null = null
  let to: string | null = null
  let amountLgt: number | null = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from' && i + 1 < argv.length) {
      from = argv[++i]
    } else if (a === '--to' && i + 1 < argv.length) {
      to = argv[++i]
    } else if (a === '--amount' && i + 1 < argv.length) {
      amountLgt = Number(argv[++i])
    } else if (a === '-h' || a === '--help') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`unknown argument: ${a}`)
      printUsage()
      process.exit(2)
    }
  }

  if (!to) {
    console.error('--to <address> is required')
    printUsage()
    process.exit(2)
  }
  if (!amountLgt || amountLgt <= 0) {
    console.error('--amount <LGT> is required and must be > 0')
    printUsage()
    process.exit(2)
  }
  return { from, to, amountLgt }
}

function printUsage(): void {
  console.error(`usage: transfer --to <address> --amount <LGT> [--from FILE]

Build + sign + submit a transfer on Ligate Chain.

Required:
  --to ADDRESS    Recipient (bech32m \`lig1...\`).
  --amount LGT    Amount in whole LGT (e.g. 1, 0.5).

Optional:
  --from FILE     Sender keypair JSON (default: the localnet dev key).
  -h, --help      Show this message.

Environment:
  LIGATE_RPC, LIGATE_CHAIN_ID, LIGATE_TOKEN_ID override defaults.
`)
}

async function main(): Promise<void> {
  const { from, to, amountLgt } = parseArgs(process.argv.slice(2))

  // Load sender key.
  let senderPrivateKeyHex: string
  if (from) {
    const text = readFileSync(from, 'utf8')
    const parsed = JSON.parse(text) as { privateKeyHex?: string }
    if (typeof parsed.privateKeyHex !== 'string') {
      throw new Error(`${from}: missing "privateKeyHex" field`)
    }
    senderPrivateKeyHex = parsed.privateKeyHex
    console.log(`Loaded sender key from ${from}`)
  } else {
    senderPrivateKeyHex = DEV_KEY_HEX
    console.log('Using localnet dev key (pre-funded with 10000 LGT).')
  }

  const sender = keypairFromPrivateKey(senderPrivateKeyHex)
  console.log(`Sender address: ${sender.address}`)

  // Connect to chain.
  const client = new LigateClient({ rpcUrl: RPC_URL })
  const info = await client.getRollupInfo()
  console.log(`Chain: ${info.chain_id} (${info.version})`)

  // Look up nonce + balance.
  const [nonce, senderBalance, recipientBalanceBefore] = await Promise.all([
    client.getNonce(sender.publicKey),
    client.getBalance(sender.address, TOKEN_ID),
    client.getBalance(to, TOKEN_ID),
  ])
  console.log(`Nonce:            ${nonce}`)
  console.log(`Sender balance:   ${formatLgt(senderBalance)} LGT`)
  console.log(`Recipient before: ${formatLgt(recipientBalanceBefore)} LGT`)

  // 1 LGT = 1_000_000_000 nano.
  const amountNano = BigInt(Math.round(amountLgt * 1_000_000_000))

  if (senderBalance < amountNano) {
    throw new Error(
      `insufficient balance: ${formatLgt(senderBalance)} LGT available, ` +
        `${amountLgt} LGT requested`,
    )
  }

  console.log(`Submitting transfer: ${amountLgt} LGT -> ${to}`)
  const result = await submitTransfer({
    rpcUrl: RPC_URL,
    privateKey: senderPrivateKeyHex,
    publicKey: sender.publicKey,
    to,
    amountNano,
    tokenId: TOKEN_ID,
    nonce,
    chainId: CHAIN_ID,
    chainHash: info.chain_hash,
  })

  console.log(`Tx hash:    ${result.txHash}`)
  console.log(`Included:   ${result.included}`)

  if (result.included) {
    const recipientBalanceAfter = await client.getBalance(to, TOKEN_ID)
    console.log(`Recipient after: ${formatLgt(recipientBalanceAfter)} LGT`)
    console.log(
      `Delta:           +${formatLgt(recipientBalanceAfter - recipientBalanceBefore)} LGT`,
    )
  } else {
    console.log('(tx queued but not yet included; check the explorer)')
  }
}

function formatLgt(nano: bigint): string {
  const whole = nano / 1_000_000_000n
  const frac = nano % 1_000_000_000n
  return `${whole}.${frac.toString().padStart(9, '0')}`
}

main().catch((e) => {
  console.error('error:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
