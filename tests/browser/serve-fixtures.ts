/**
 * Tiny HTTP server for Playwright fixtures.
 *
 * Chromium and WebKit block ES module imports over `file://` (a
 * cross-origin security restriction). Firefox is more permissive,
 * which is why the matrix was passing Firefox and failing the other
 * two engines. Serving the fixtures over HTTP fixes all three.
 *
 * Run via Playwright's `webServer` config (see `playwright.config.ts`).
 * Listens on `PORT` (default 4173) and serves `tests/browser/fixtures/`.
 * Mime types are minimal but cover what the fixture page imports
 * (`.html`, `.js`, `.js.map`).
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, 'fixtures')
const PORT = Number(process.env.PORT ?? 4173)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  // Resolve the requested path inside ROOT; default to index file
  // when the request is `/`.
  const rel = url.pathname === '/' ? '/test.html' : url.pathname
  const filePath = normalize(join(ROOT, rel))

  // Path-traversal guard. Anything outside ROOT 404s.
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }

  try {
    const st = statSync(filePath)
    if (!st.isFile()) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream')
    res.setHeader('content-length', String(st.size))
    createReadStream(filePath).pipe(res)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`serving ${ROOT} at http://localhost:${PORT}`)
})
