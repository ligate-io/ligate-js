/**
 * Playwright config for the browser-target test matrix.
 *
 * Proves the README's "works in modern browsers" claim by running
 * the SDK's core surface (key generation, address derivation, tx
 * signing) inside Chromium, Firefox, and WebKit and asserting the
 * output matches the Node-side expectations.
 *
 * Tests live in `tests/browser/`. They serve a tiny static HTML
 * page that imports the built SDK bundle, exercise the surface in
 * the browser context, and assert via Playwright's `expect`.
 *
 * Run locally:
 *   pnpm exec playwright install   # one-time: download browsers
 *   pnpm build                     # required: tests use dist/
 *   pnpm exec playwright test
 *
 * In CI, the `browser` job in `.github/workflows/ci.yml` does the
 * same.
 */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: 'list',
  // Bundles the SDK once with esbuild before any spec runs; see
  // `tests/browser/global-setup.ts`.
  globalSetup: './tests/browser/global-setup.ts',
  use: {
    // We serve test pages over file://, so no baseURL.
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
