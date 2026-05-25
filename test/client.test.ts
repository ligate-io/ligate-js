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
import { tokenIdToHex } from '../src/token.js'

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

  it('hits the /v1/rollup/addresses/{cred_id}/dedup endpoint', async () => {
    let observedUrl = ''
    const fetchImpl = stubFetch((url) => {
      observedUrl = url
      return jsonResponse({ nonce: 42 })
    })
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    const nonce = await client.getNonce(pubkey)
    expect(observedUrl).toBe(`http://x:1/v1/rollup/addresses/${credentialIdHex}/dedup`)
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
  // Canonical AVOW gas-token id from the SDK's bank-genesis fixture.
  // Used as the test token id below — a real bech32m string so the
  // client's `tokenIdToBech32m` validation round-trip passes.
  const LGT_TOKEN_ID = 'token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7'

  it('hits /v1/modules/bank/tokens/{token}/balances/{address}', async () => {
    let observedUrl = ''
    const fetchImpl = stubFetch((url) => {
      observedUrl = url
      return jsonResponse({
        token_id: LGT_TOKEN_ID,
        amount: '12345',
      })
    })
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    const balance = await client.getBalance('lig1abc', LGT_TOKEN_ID)
    expect(observedUrl).toBe(`http://x:1/v1/modules/bank/tokens/${LGT_TOKEN_ID}/balances/lig1abc`)
    expect(balance).toBe(12345n)
  })

  it('accepts a hex token id and converts to bech32m for the URL', async () => {
    let observedUrl = ''
    const fetchImpl = stubFetch((url) => {
      observedUrl = url
      return jsonResponse({ token_id: LGT_TOKEN_ID, amount: '0' })
    })
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    // Derive the canonical AVOW id's hex form via the helper itself,
    // so we don't drift if the underlying byte representation changes.
    const lgtHex = tokenIdToHex(LGT_TOKEN_ID)
    expect(lgtHex).toMatch(/^[0-9a-f]{64}$/)
    await client.getBalance('lig1abc', lgtHex)
    expect(observedUrl).toContain(`/tokens/${LGT_TOKEN_ID}/`)
  })

  it('returns 0n on 404 (no recorded balance)', async () => {
    const fetchImpl = stubFetch(() => new Response('', { status: 404 }))
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    expect(await client.getBalance('lig1abc', LGT_TOKEN_ID)).toBe(0n)
  })
})

/**
 * Indexer query method URL pinning.
 *
 * These tests assert that LigateClient hits the URL paths documented
 * by ligate-api's handlers (`/v1/blocks*`, `/v1/txs*`,
 * `/v1/addresses/*`, `/v1/schemas*`, `/v1/attestor-sets/*`). If
 * ligate-api changes a route here without bumping the SDK, CI
 * catches it via these stubs.
 *
 * Response shapes are not pinned (ligate-api returns 501 placeholders
 * until issue #1 lands); the tests just verify the request URL.
 */
describe('LigateClient indexer query methods', () => {
  function captureUrl(): { fetch: typeof fetch; url: () => string } {
    let observed = ''
    const fetchImpl = stubFetch((url) => {
      observed = url
      return jsonResponse({})
    })
    return { fetch: fetchImpl, url: () => observed }
  }

  it('listBlocks hits /v1/blocks (no query when params absent)', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.listBlocks()
    expect(url()).toBe('http://x:1/v1/blocks')
  })

  it('listBlocks forwards limit + before as query params', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.listBlocks({ limit: 50, before: 'h:12345' })
    // url-encoding of `:` is %3A; assert via decoded form to keep the
    // expectation readable.
    const decoded = decodeURIComponent(url())
    expect(decoded).toBe('http://x:1/v1/blocks?limit=50&before=h:12345')
  })

  it('getBlock(height) hits /v1/blocks/{height}', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.getBlock(42)
    expect(url()).toBe('http://x:1/v1/blocks/42')
  })

  it('getBlock accepts bigint heights (chain heights are u64)', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.getBlock(9_007_199_254_740_993n)
    expect(url()).toBe('http://x:1/v1/blocks/9007199254740993')
  })

  it('listTxs hits /v1/txs', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.listTxs({ limit: 10 })
    expect(url()).toBe('http://x:1/v1/txs?limit=10')
  })

  it('getTx hits /v1/txs/{hash}', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.getTx('0xdeadbeef')
    expect(url()).toBe('http://x:1/v1/txs/0xdeadbeef')
  })

  it('getAddressSummary hits /v1/addresses/{addr}', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.getAddressSummary('lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u')
    expect(url()).toBe(
      'http://x:1/v1/addresses/lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u',
    )
  })

  it('listSchemas hits /v1/schemas', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.listSchemas()
    expect(url()).toBe('http://x:1/v1/schemas')
  })

  it('getSchema hits /v1/schemas/{id}', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.getSchema('lsc1abc')
    expect(url()).toBe('http://x:1/v1/schemas/lsc1abc')
  })

  it('getAttestorSet hits /v1/attestor-sets/{id}', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.getAttestorSet('las1abc')
    expect(url()).toBe('http://x:1/v1/attestor-sets/las1abc')
  })

  it('listAttestorSets hits /v1/attestor-sets', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.listAttestorSets()
    expect(url()).toBe('http://x:1/v1/attestor-sets')
  })

  it('listAttestations hits /v1/attestations', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.listAttestations()
    expect(url()).toBe('http://x:1/v1/attestations')
  })

  it('listAttestations forwards limit + before as query params', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.listAttestations({ limit: 25, before: 'lat1cursor' })
    expect(url()).toBe('http://x:1/v1/attestations?limit=25&before=lat1cursor')
  })

  it('getAttestation hits /v1/attestations/{id}', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.getAttestation('lat1abc')
    expect(url()).toBe('http://x:1/v1/attestations/lat1abc')
  })

  it('listAttestationsBySchema hits /v1/schemas/{id}/attestations', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.listAttestationsBySchema('lsc1abc', { limit: 10 })
    expect(url()).toBe('http://x:1/v1/schemas/lsc1abc/attestations?limit=10')
  })

  it('listAttestationsByAttestor hits /v1/attestors/{pubkey}/attestations', async () => {
    const { fetch: fetchImpl, url } = captureUrl()
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    await client.listAttestationsByAttestor('lpk1abc')
    expect(url()).toBe('http://x:1/v1/attestors/lpk1abc/attestations')
  })

  it('passes a generic response type through getJson', async () => {
    interface MockSchema {
      id: string
      name: string
    }
    const fetchImpl = stubFetch(() =>
      jsonResponse({ id: 'lsc1abc', name: 'themisra.proof-of-prompt' }),
    )
    const client = new LigateClient({ rpcUrl: 'http://x:1', fetch: fetchImpl })
    const schema = await client.getSchema<MockSchema>('lsc1abc')
    // Strict-typed access proves the generic flowed through.
    expect(schema.name).toBe('themisra.proof-of-prompt')
  })
})
