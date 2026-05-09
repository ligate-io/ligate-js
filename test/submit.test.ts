/**
 * Submit-pipeline shape tests.
 *
 * Like `client.test.ts`, this hits a stub fetch — we're verifying the
 * request body shape and the polling sequence, not the chain's
 * responses. End-to-end goes against a real localnet in `e2e/`.
 */

import { describe, expect, it } from 'vitest'

import {
  REGISTER_ATTESTOR_SET_DISC,
  REGISTER_SCHEMA_DISC,
  RUNTIME_ATTESTATION_DISC,
  SUBMIT_ATTESTATION_DISC,
} from '../src/attestation.js'
import { LigateClient } from '../src/client.js'
import {
  submitAttestation,
  submitRawTx,
  submitRegisterAttestorSet,
  submitRegisterSchema,
  waitForInclusion,
} from '../src/submit.js'

const DEV_PRIVATE_KEY = '01'.repeat(32)
const DUMMY_CHAIN_HASH = 'bb'.repeat(32)

/** ed25519 signature + 32-byte pubkey live in [1..97) of the envelope. */
const ENVELOPE_HEADER_LEN = 1 + 64 + 32

function bytesFromBase64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('submitRawTx', () => {
  it('POSTs base64-encoded body to /v1/sequencer/txs', async () => {
    let observedUrl = ''
    let observedInit: RequestInit | undefined
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      // Two requests: first POST to /sequencer/txs, second GET to /ledger/txs/...
      if (init?.method === 'POST') {
        observedUrl = url
        observedInit = init
        return jsonResponse({ id: 'deadbeef' })
      }
      return jsonResponse({ status: 'committed' })
    }) as typeof fetch

    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    const result = await submitRawTx(client, new Uint8Array([1, 2, 3, 4]), {
      pollIntervalMs: 1,
      timeoutMs: 5000,
    })

    expect(observedUrl).toBe('http://x:1/v1/sequencer/txs')
    expect(observedInit?.method).toBe('POST')
    const body = JSON.parse(observedInit?.body as string) as { body: string }
    // base64 of [1,2,3,4] = "AQIDBA=="
    expect(body.body).toBe('AQIDBA==')
    expect(result.txHash).toBe('deadbeef')
    expect(result.included).toBe(true)
  })

  it('returns immediately with included=false when waitForInclusion is false', async () => {
    let pollCount = 0
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        pollCount++
      }
      return jsonResponse({ id: 'feedface' })
    }) as typeof fetch

    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    const result = await submitRawTx(client, new Uint8Array([0]), {
      waitForInclusion: false,
    })
    expect(result).toEqual({ txHash: 'feedface', included: false })
    expect(pollCount).toBe(0)
  })
})

describe('waitForInclusion', () => {
  it('polls until the chain returns 2xx', async () => {
    let attempts = 0
    const fetchImpl = (async () => {
      attempts++
      if (attempts < 3) {
        return new Response('not found', { status: 404 })
      }
      return jsonResponse({ status: 'committed' })
    }) as typeof fetch

    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await waitForInclusion(client, 'cafebabe', { pollIntervalMs: 1, timeoutMs: 1000 })
    expect(attempts).toBe(3)
  })

  it('throws on timeout', async () => {
    const fetchImpl = (async () => new Response('', { status: 404 })) as typeof fetch
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await expect(
      waitForInclusion(client, 'cafebabe', { pollIntervalMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow(/timed out/)
  })
})

/**
 * Stub-fetch harness for the attestation submit helpers. Captures the
 * POST body so each test can decode the inner signed-tx bytes and
 * assert that the right runtime-call discriminants were emitted.
 */
function captureSubmitFetch(): { fetch: typeof fetch; observed: { url?: string; body?: string } } {
  const observed: { url?: string; body?: string } = {}
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (init?.method === 'POST') {
      observed.url = url
      observed.body = init.body as string
      return jsonResponse({ id: 'feedface' })
    }
    return jsonResponse({ status: 'committed' })
  }) as typeof fetch
  return { fetch: fetchImpl, observed }
}

describe('submitRegisterAttestorSet', () => {
  it('POSTs RegisterAttestorSet bytes to /v1/sequencer/txs', async () => {
    const { fetch: fetchImpl, observed } = captureSubmitFetch()
    const member = new Uint8Array(32).fill(0xaa)

    const result = await submitRegisterAttestorSet({
      rpcUrl: 'http://x:1',
      fetch: fetchImpl,
      privateKey: DEV_PRIVATE_KEY,
      publicKey: new Uint8Array(32).fill(0x01),
      members: [member],
      threshold: 1,
      nonce: 0n,
      chainId: 4242n,
      chainHash: DUMMY_CHAIN_HASH,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    })

    expect(observed.url).toBe('http://x:1/v1/sequencer/txs')
    const { body } = JSON.parse(observed.body!) as { body: string }
    const envelope = bytesFromBase64(body)
    // First runtime-call byte is the module discriminant; second is the variant.
    expect(envelope[ENVELOPE_HEADER_LEN]).toBe(RUNTIME_ATTESTATION_DISC)
    expect(envelope[ENVELOPE_HEADER_LEN + 1]).toBe(REGISTER_ATTESTOR_SET_DISC)
    expect(result).toEqual({ txHash: 'feedface', included: true })
  })
})

describe('submitRegisterSchema', () => {
  it('POSTs RegisterSchema bytes to /v1/sequencer/txs', async () => {
    const { fetch: fetchImpl, observed } = captureSubmitFetch()

    const result = await submitRegisterSchema({
      rpcUrl: 'http://x:1',
      fetch: fetchImpl,
      privateKey: DEV_PRIVATE_KEY,
      publicKey: new Uint8Array(32).fill(0x01),
      name: 'themisra.proof-of-prompt',
      version: 1,
      attestorSetId: new Uint8Array(32).fill(0xab),
      payloadShapeHash: 'cd'.repeat(32),
      nonce: 0n,
      chainId: 4242n,
      chainHash: DUMMY_CHAIN_HASH,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    })

    expect(observed.url).toBe('http://x:1/v1/sequencer/txs')
    const { body } = JSON.parse(observed.body!) as { body: string }
    const envelope = bytesFromBase64(body)
    expect(envelope[ENVELOPE_HEADER_LEN]).toBe(RUNTIME_ATTESTATION_DISC)
    expect(envelope[ENVELOPE_HEADER_LEN + 1]).toBe(REGISTER_SCHEMA_DISC)
    expect(result.included).toBe(true)
  })
})

describe('submitAttestation', () => {
  it('POSTs SubmitAttestation bytes to /v1/sequencer/txs', async () => {
    const { fetch: fetchImpl, observed } = captureSubmitFetch()

    const result = await submitAttestation({
      rpcUrl: 'http://x:1',
      fetch: fetchImpl,
      privateKey: DEV_PRIVATE_KEY,
      publicKey: new Uint8Array(32).fill(0x01),
      schemaId: new Uint8Array(32).fill(0xcc),
      payloadHash: new Uint8Array(32).fill(0xdd),
      // Single fake attestor signature; the SDK doesn't verify, only
      // packages — chain-side rejection is e2e's concern.
      signatures: [
        {
          pubkey: new Uint8Array(32).fill(0xaa),
          sig: new Uint8Array(64).fill(0xee),
        },
      ],
      nonce: 0n,
      chainId: 4242n,
      chainHash: DUMMY_CHAIN_HASH,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    })

    expect(observed.url).toBe('http://x:1/v1/sequencer/txs')
    const { body } = JSON.parse(observed.body!) as { body: string }
    const envelope = bytesFromBase64(body)
    expect(envelope[ENVELOPE_HEADER_LEN]).toBe(RUNTIME_ATTESTATION_DISC)
    expect(envelope[ENVELOPE_HEADER_LEN + 1]).toBe(SUBMIT_ATTESTATION_DISC)
    expect(result.included).toBe(true)
  })
})
