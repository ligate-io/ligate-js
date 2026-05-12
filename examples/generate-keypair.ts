#!/usr/bin/env -S node --import tsx
/**
 * Example: generate a Ligate Chain keypair.
 *
 * Generates a fresh Ed25519 keypair, prints the address + pubkey,
 * and (optionally) writes the private key to a file.
 *
 * Equivalent to the Rust CLI's `ligate keys generate --name <name>`.
 *
 * ## Usage
 *
 * ```sh
 * pnpm tsx examples/generate-keypair.ts
 * pnpm tsx examples/generate-keypair.ts --out my-key.json
 * ```
 *
 * ## Output format
 *
 * When `--out FILE` is given, writes:
 *
 * ```json
 * {
 *   "address": "lig1...",
 *   "publicKeyHex": "...",
 *   "privateKeyHex": "..."
 * }
 * ```
 *
 * Mode `0600` on POSIX. Never check this file into git.
 */

import { writeFileSync, chmodSync } from 'node:fs'
import process from 'node:process'

import { bytesToHex, generateKeypair } from '../src/index.js'

function parseArgs(argv: string[]): { out: string | null } {
  let out: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out' && i + 1 < argv.length) {
      out = argv[i + 1]
      i++
    } else if (a === '-h' || a === '--help') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`unknown argument: ${a}`)
      printUsage()
      process.exit(2)
    }
  }
  return { out }
}

function printUsage(): void {
  console.error(`usage: generate-keypair [--out FILE]

Generate a fresh Ed25519 keypair for Ligate Chain.

Options:
  --out FILE   Write the keypair as JSON to FILE (mode 0600).
               If omitted, prints to stdout only.
  -h, --help   Show this message and exit.
`)
}

function main(): void {
  const { out } = parseArgs(process.argv.slice(2))

  const kp = generateKeypair()
  const publicKeyHex = bytesToHex(kp.publicKey)

  console.log('Generated Ed25519 keypair:')
  console.log(`  address:    ${kp.address}`)
  console.log(`  pubkey:     0x${publicKeyHex}`)
  console.log(`  privateKey: 0x${kp.privateKeyHex} (KEEP SECRET)`)

  if (out) {
    const json = JSON.stringify(
      {
        address: kp.address,
        publicKeyHex,
        privateKeyHex: kp.privateKeyHex,
      },
      null,
      2,
    )
    writeFileSync(out, json + '\n', { encoding: 'utf8' })
    try {
      chmodSync(out, 0o600)
    } catch {
      // chmod isn't supported on Windows; not fatal for the example.
    }
    console.log(`\nWrote keypair to ${out} (mode 0600).`)
    console.log('Treat the file like a wallet seed — do not commit, do not share.')
  }
}

try {
  main()
} catch (e) {
  console.error('error:', e instanceof Error ? e.message : String(e))
  process.exit(1)
}
