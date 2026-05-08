/**
 * `LigateClient` URL-shape tests using a stub fetch.
 *
 * The point isn't to test the chain's responses (that's e2e's job)
 * but to pin the URL paths the client constructs. If anyone changes
 * a path here without updating the chain side (or vice versa), CI
 * catches it.
 */

import { describe, expect, it } from 'vitest'

import { LigateClient, appendV1 } from '../src/client.js'

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  // The cast lets us hand a plain function in where `fetch`'s
  // overload signature is expected.
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    return handler(url, init)
  }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('appendV1', () => {
  it('adds /v1 when missing', () => {
    expect(appendV1('http://localhost:12346')).toBe('http://localhost:12346/v1')
  })

  it('strips trailing slashes before appending', () => {
    expect(appendV1('http://localhost:12346/')).toBe('http://localhost:12346/v1')
    expect(appendV1('http://localhost:12346///')).toBe('http://localhost:12346/v1')
  })

  it('is idempotent', () => {
    expect(appendV1('http://localhost:12346/v1')).toBe('http://localhost:12346/v1')
    expect(appendV1('http://localhost:12346/v1/')).toBe('http://localhost:12346/v1')
  })
})

describe('LigateClient.getRollupInfo', () => {
  it('hits /v1/rollup/info', async () => {
    let observedUrl = ''
    const fetchImpl = stubFetch((url) => {
      observedUrl = url
      return jsonResponse({
        chain_id: 'ligate-localnet-1',
        chain_hash: 'aa'.repeat(32),
        version: '0.0.1',
      })
    })
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    const info = await client.getRollupInfo()
    expect(observedUrl).toBe('http://x:1/v1/rollup/info')
    expect(info.chain_id).toBe('ligate-localnet-1')
  })
})

describe('LigateClient.getNonce', () => {
  const pubkey = new Uint8Array(32).fill(0xab)
  const credentialIdHex = 'ab'.repeat(32)

  it('uses the credential-id (hex pubkey) state path', async () => {
    let observedUrl = ''
    const fetchImpl = stubFetch((url) => {
      observedUrl = url
      return jsonResponse({ value: 42 })
    })
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    const nonce = await client.getNonce(pubkey)
    expect(observedUrl).toBe(`http://x:1/v1/modules/nonces/state/nonces/items/${credentialIdHex}`)
    expect(nonce).toBe(42n)
  })

  it('returns 0 when the chain returns 404 (never-sent-a-tx)', async () => {
    const fetchImpl = stubFetch(() => new Response('', { status: 404 }))
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    expect(await client.getNonce(pubkey)).toBe(0n)
  })

  it('rejects 32-byte mismatches', async () => {
    const client = new LigateClient({
      rpcUrl: 'http://x:1',
      fetch: stubFetch(() => jsonResponse({})),
    })
    await expect(client.getNonce(new Uint8Array(31))).rejects.toThrow(/32-byte/)
  })
})

describe('LigateClient.getBalance', () => {
  it('hits /v1/modules/bank/tokens/{token}/balances/{address}', async () => {
    let observedUrl = ''
    const fetchImpl = stubFetch((url) => {
      observedUrl = url
      return jsonResponse({
        token_id: 'token_1abcdef',
        amount: '12345',
      })
    })
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    const balance = await client.getBalance('lig1abc', 'token_1xyz')
    expect(observedUrl).toBe('http://x:1/v1/modules/bank/tokens/token_1xyz/balances/lig1abc')
    expect(balance).toBe(12345n)
  })

  it('returns 0n on 404 (no recorded balance)', async () => {
    const fetchImpl = stubFetch(() => new Response('', { status: 404 }))
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    expect(await client.getBalance('lig1abc', 'token_1xyz')).toBe(0n)
  })
})
