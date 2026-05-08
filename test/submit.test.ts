/**
 * Submit-pipeline shape tests.
 *
 * Like `client.test.ts`, this hits a stub fetch — we're verifying the
 * request body shape and the polling sequence, not the chain's
 * responses. End-to-end goes against a real localnet in `e2e/`.
 */

import { describe, expect, it } from 'vitest'

import { LigateClient } from '../src/client.js'
import { submitRawTx, waitForInclusion } from '../src/submit.js'

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
