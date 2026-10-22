/**
 * session-focus.ts — which chat the person is looking at
 *
 * The chat page tells the gateway whenever it shows a different session (sessions.focus). Anything else that talks to Dave on
 * the person's behalf, such as the voice bridge, asks sessions.focused and joins that same chat, so what is said shows up on
 * the page in front of them. Held in memory only: after a restart the page tells it again as soon as it reconnects.
 */

const MAX_AGE_MS = 12 * 60 * 60 * 1000   // a chat page left open overnight is not "being looked at" any more

let focused: { sessionId: string; at: number } | null = null

export function setFocusedSession(sessionId: string, now: number = Date.now()): void {
  focused = { sessionId, at: now }
}

/** The session the page last showed, or null if none was reported lately. */
export function getFocusedSession(now: number = Date.now()): string | null {
  if (!focused || now - focused.at > MAX_AGE_MS) return null
  return focused.sessionId
}

export function clearFocusedSession(): void {
  focused = null
}
