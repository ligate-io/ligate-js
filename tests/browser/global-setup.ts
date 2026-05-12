/**
 * Playwright global setup: bundle the SDK once before any browser
 * test runs.
 *
 * We use `esbuild --bundle --format=esm --platform=browser` (the same
 * flags as the existing `bundle:browser-check` script that proves
 * no Node-only imports leaked in). Output: `tests/browser/fixtures/
 * sdk.bundle.js`, loaded by `test.html` as a `<script type="module">`.
 *
 * Done once per test run rather than per test so the browser-target
 * bundle exists before any spec navigates to the fixture page.
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default async function globalSetup(): Promise<void> {
  const outfile = resolve(__dirname, 'fixtures/sdk.bundle.js')
  mkdirSync(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [resolve(__dirname, '../../src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile,
    sourcemap: 'inline',
    logLevel: 'info',
  })
}
