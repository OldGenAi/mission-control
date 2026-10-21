/**
 * http-app.ts — the gateway's HTTP side: health, sign-in handoff, and the built UI
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Serving the finished UI from the gateway means one program and one address, with no
 * dev server. Every request must carry a loopback Host header (DNS-rebinding guard);
 * the UI is sent with a strict Content-Security-Policy.
 */

import { existsSync } from 'fs'
import { join, resolve } from 'path'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import { validateHost, isOwnOrigin } from './auth.js'
import { issueLaunchChallenge, issueLaunchCode, redeemLaunchCode, issueSession } from './login.js'

/** app/dist next to the gateway, or MC_UI_DIR. Null when no build exists (dev uses Vite). */
export function resolveUiDir(): string | null {
  const dir = process.env['MC_UI_DIR'] ?? resolve(__dirname, '..', '..', 'app', 'dist')
  return existsSync(join(dir, 'index.html')) ? dir : null
}

function bodyField(req: Request, name: string): unknown {
  return (req.body as Record<string, unknown> | undefined)?.[name]
}

// The Host header is already validated (first middleware), so it is safe to echo here.
function setUiSecurityHeaders(req: Request, res: Response): void {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    // Inline styles: the components use React style props. Scripts stay 'self' only (XSS).
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    `connect-src 'self' ws://${req.headers.host}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

export function buildHttpApp(uiDir: string | null): Express {
  const app = express()
  app.disable('x-powered-by')

  // DNS rebinding: refuse any request whose Host is not this machine.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!validateHost(req.headers.host)) {
      res.status(403).json({ ok: false, error: 'HOST_NOT_ALLOWED' })
      return
    }
    next()
  })

  app.use(express.json({ limit: '4kb' }))
  app.use('/auth', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })

  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() })
  })

  // Launcher only. Browsers always send Origin on a POST, so refusing any Origin keeps
  // web pages out of the launcher endpoints entirely.
  app.post('/auth/challenge', (req, res) => {
    if (req.headers.origin !== undefined) {
      res.status(403).json({ ok: false, error: 'AUTH_FAILED' })
      return
    }
    res.json({ ok: true, nonce: issueLaunchChallenge() })
  })

  app.post('/auth/launch', (req, res) => {
    const code = req.headers.origin === undefined
      ? issueLaunchCode(bodyField(req, 'nonce'), bodyField(req, 'proof'))
      : null
    if (!code) {
      res.status(403).json({ ok: false, error: 'AUTH_FAILED' })
      return
    }
    res.json({ ok: true, code })
  })

  // Page -> session. Only the page this gateway served may redeem (another local
  // server on a different port would otherwise pass a loopback check).
  app.post('/auth/redeem', (req, res) => {
    if (!isOwnOrigin(req.headers.origin, req.headers.host) || !redeemLaunchCode(bodyField(req, 'code'))) {
      res.status(403).json({ ok: false, error: 'LOGIN_LINK_INVALID' })
      return
    }
    res.json({ ok: true, ...issueSession() })
  })

  if (uiDir) {
    app.use((req, res, next) => { setUiSecurityHeaders(req, res); next() })

    // Vite fingerprints everything under /assets, so those can be cached for good.
    app.use('/assets', express.static(join(uiDir, 'assets'), {
      index: false,
      fallthrough: false,
      setHeaders: (res) => { res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') },
    }))

    app.use(express.static(uiDir, {
      index: false,
      setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache') },
    }))

    // Client-side routes (/chat, /settings, ...) all load the app shell.
    const indexHtml = join(uiDir, 'index.html')
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.sendFile(indexHtml)
    })
  }

  // Status code only. Express's default handler would send a stack trace (with file
  // paths) to the browser whenever NODE_ENV is not "production".
  app.use((err: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500
    if (status >= 500) console.error('[http] request failed:', err)
    res.status(status).end()
  })

  return app
}
