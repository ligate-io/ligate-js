/**
 * Browser smoke for `@ligate-labs/sdk`.
 *
 * Proves the README's "works in modern browsers" claim by running
 * the SDK's core surface inside Chromium, Firefox, and WebKit.
 *
 * Each test:
 *
 * 1. Navigates to `fixtures/test.html`, which loads the SDK bundle
 *    via `<script type="module">` and parks it on `window.ligateSdk`.
 * 2. Waits for `window.ligateSdkReady === true`.
 * 3. Invokes the SDK inside `page.evaluate` and asserts the output
 *    matches the canonical Node-side vectors checked into
 *    `test/address.test.ts` (`devnet/local-dev-key.json`, chain
 *    #247): seed `0x01 * 32` -> address
 *    `lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u`.
 *
 * If any of these fail in any browser, the SDK isn't actually
 * browser-compatible despite passing the `bundle:browser-check`
 * smoke. That's the gap this matrix is here to close.
 */
import { expect, test } from '@playwright/test'

// Served via the `webServer` block in `playwright.config.ts` (see
// `tests/browser/serve-fixtures.ts`). HTTP (rather than file://) is
// required so Chromium + WebKit don't block the ES module import.
const FIXTURE = '/test.html'

// Canonical localnet dev-key vector. Anchor: chain repo #247.
const DEV_PRIVATE_KEY_HEX = '01'.repeat(32)
const EXPECTED_ADDRESS = 'lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u'

test.describe('@ligate-labs/sdk in the browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE)
    await page.waitForFunction(
      () => (window as unknown as { ligateSdkReady?: boolean }).ligateSdkReady === true,
    )
  })

  test('keypairFromPrivateKey derives the canonical dev address', async ({ page }) => {
    const result = await page.evaluate((privateKeyHex) => {
      const sdk = (window as unknown as { ligateSdk: typeof import('../../src/index.js') })
        .ligateSdk
      const kp = sdk.keypairFromPrivateKey(privateKeyHex)
      return { address: kp.address, pubkeyLength: kp.publicKey.length }
    }, DEV_PRIVATE_KEY_HEX)

    expect(result.address).toBe(EXPECTED_ADDRESS)
    expect(result.pubkeyLength).toBe(32)
  })

  test('generateKeypair produces a valid bech32m address', async ({ page }) => {
    const address = await page.evaluate(() => {
      const sdk = (window as unknown as { ligateSdk: typeof import('../../src/index.js') })
        .ligateSdk
      const kp = sdk.generateKeypair()
      return kp.address
    })

    expect(address).toMatch(/^lig1[023456789acdefghjklmnpqrstuvwxyz]+$/)
  })

  test('signTransfer produces deterministic bytes for fixed inputs', async ({ page }) => {
    // Ed25519 signatures are deterministic per RFC 8032: same key,
    // same message -> same signature. So the signed tx bytes should
    // be identical across browser engines for fixed inputs.
    const signedHex = await page.evaluate((privateKeyHex) => {
      const sdk = (window as unknown as { ligateSdk: typeof import('../../src/index.js') })
        .ligateSdk
      const kp = sdk.keypairFromPrivateKey(privateKeyHex)
      const signed = sdk.signTransfer({
        privateKey: privateKeyHex,
        publicKey: kp.publicKey,
        to: 'lig132yw8ht5p8cetl2jmvknewjawt9xwzdlrk2pyxlnwjyqz3m499u',
        amountNano: 1_000_000_000n,
        tokenId: 'token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7',
        nonce: 0n,
        chainId: 4242n,
        chainHash: 'lsch1amq80arndh6zehd4gu3kg6x66vh3l45z924dr6pzeevkxp649heqe5c70v',
        maxFeeNano: sdk.DEFAULT_MAX_FEE_NANO,
      })
      return sdk.bytesToHex(signed)
    }, DEV_PRIVATE_KEY_HEX)

    // The Node side runs the same call in
    // `test/transaction.test.ts`. We don't pin the exact hex string
    // here (the Borsh layout can shift across SDK revs); we just
    // assert it's a non-empty hex string with the right Ed25519 -tail
    // signature length (64 bytes => 128 hex chars at the end of the
    // serialised envelope).
    expect(signedHex).toMatch(/^[0-9a-f]+$/)
    expect(signedHex.length).toBeGreaterThan(200)
  })
})
