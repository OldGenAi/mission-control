// Browser session for the built UI (served by the gateway itself).
//
// The launcher opens /#login=<one-time code>; we swap the code for a signed session
// at POST /auth/redeem and keep it in localStorage. The gateway token never reaches
// the browser. See gateway/src/login.ts. The Vite dev server keeps using the token.

const SESSION_KEY = 'mc.session'

export function loadSession(): string | null {
  try { return localStorage.getItem(SESSION_KEY) } catch { return null }
}

export function saveSession(session: string): void {
  try { localStorage.setItem(SESSION_KEY, session) } catch { /* private window: signed in for this tab only */ }
}

export function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* nothing stored */ }
}

/** Redeems a #login=<code> link, then removes it from the address bar and history. */
export async function redeemLoginLink(): Promise<void> {
  const match = /^#login=([0-9a-f]{64})$/.exec(location.hash)
  if (!match) return
  history.replaceState(null, '', location.pathname + location.search)
  try {
    const res = await fetch('/auth/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: match[1] }),
    })
    const body = (await res.json()) as { session?: unknown }
    if (res.ok && typeof body.session === 'string') saveSession(body.session)
  } catch { /* gateway gone or code used up: the sign-in screen explains what to do */ }
}

export function needsSignIn(): boolean {
  return !import.meta.env.DEV && !loadSession()
}
