#!/usr/bin/env -S node --import tsx
/**
 * Example: poll an address's balance on Ligate Chain.
 *
 * Demonstrates the read-side query surface. Polls the configured
 * address's balance for a token every N seconds, prints each
 * snapshot + the delta from the previous tick.
 *
 * ## Usage
 *
 * ```sh
 * pnpm tsx examples/watch-balance.ts lig1u8z2rxh6ymjwkqsasme64f5kfphtfm2kf4kkn0clusfpr34amezsp5j7yp
 * pnpm tsx examples/watch-balance.ts lig1... --interval 5
 * ```
 *
 * Hit Ctrl-C to stop. The script exits cleanly on SIGINT/SIGTERM.
 *
 * ## Environment
 *
 * | Var | Default | What |
 * |---|---|---|
 * | `LIGATE_RPC` | `http://localhost:12346` | Chain RPC URL |
 * | `LIGATE_TOKEN_ID` | localnet $LGT bech32m | Token id to watch |
 */

import process from 'node:process'

import { LigateClient } from '../src/index.js'

const RPC_URL = process.env.LIGATE_RPC || 'http://localhost:12346'
const DEFAULT_TOKEN_ID = 'token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7'
const TOKEN_ID = process.env.LIGATE_TOKEN_ID || DEFAULT_TOKEN_ID

interface Args {
  address: string
  intervalSec: number
}

function parseArgs(argv: string[]): Args {
  let address: string | null = null
  let intervalSec = 2

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--interval' && i + 1 < argv.length) {
      intervalSec = Number(argv[++i])
      if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
        console.error('--interval must be a positive number of seconds')
        process.exit(2)
      }
    } else if (a === '-h' || a === '--help') {
      printUsage()
      process.exit(0)
    } else if (a.startsWith('lig1') && !address) {
      address = a
    } else {
      console.error(`unknown argument: ${a}`)
      printUsage()
      process.exit(2)
    }
  }

  if (!address) {
    console.error('address is required (positional arg, must start with `lig1`)')
    printUsage()
    process.exit(2)
  }
  return { address, intervalSec }
}

function printUsage(): void {
  console.error(`usage: watch-balance <lig1...> [--interval SECONDS]

Poll an address's balance on Ligate Chain.

Required:
  <lig1...>           Address to watch.

Optional:
  --interval SEC      Poll interval in seconds (default: 2).
  -h, --help          Show this message.
`)
}

function formatLgt(nano: bigint): string {
  const whole = nano / 1_000_000_000n
  const frac = nano % 1_000_000_000n
  return `${whole}.${frac.toString().padStart(9, '0')}`
}

async function main(): Promise<void> {
  const { address, intervalSec } = parseArgs(process.argv.slice(2))
  const client = new LigateClient({ rpcUrl: RPC_URL })

  console.log(`Watching ${address}`)
  console.log(`Token:   ${TOKEN_ID}`)
  console.log(`RPC:     ${RPC_URL}`)
  console.log(`Tick:    ${intervalSec}s`)
  console.log('Ctrl-C to stop.\n')

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    console.log('\nStopped.')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  let previous: bigint | null = null
  let tick = 0
  while (!stopped) {
    tick += 1
    try {
      const balance = await client.getBalance(address, TOKEN_ID)
      const ts = new Date().toISOString().slice(11, 19) // HH:MM:SS
      const balanceStr = formatLgt(balance)
      if (previous === null) {
        console.log(`[${ts}] tick=${tick} balance=${balanceStr} LGT`)
      } else {
        const delta = balance - previous
        const sign = delta >= 0n ? '+' : '-'
        const deltaAbs = delta < 0n ? -delta : delta
        const deltaStr = delta === 0n ? '0' : `${sign}${formatLgt(deltaAbs)}`
        console.log(`[${ts}] tick=${tick} balance=${balanceStr} LGT (delta=${deltaStr})`)
      }
      previous = balance
    } catch (e) {
      const ts = new Date().toISOString().slice(11, 19)
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[${ts}] tick=${tick} ERROR: ${msg}`)
    }
    if (!stopped) {
      await new Promise((r) => setTimeout(r, intervalSec * 1000))
    }
  }
}

main().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
