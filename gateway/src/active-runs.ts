/**
 * active-runs.ts — registry of in-flight Dave turns.
 *
 * A chat turn runs as a detached async task (chat.ts). This registry is the only
 * handle the rest of the gateway has on it, so a turn can be:
 *   - aborted by correlationId  (the Stop button → chat.abort)
 *   - aborted by sessionId      (deleting a session must stop the running loop)
 *   - reported to the UI        (so it can restore "Dave is working" + the Stop
 *                                button after the chat tab is unmounted/remounted)
 *
 * In-memory only — runs don't survive a gateway restart (a restart kills the
 * loops anyway).
 */

export interface ActiveRun {
  correlationId: string
  sessionId: string
  controller: AbortController
}

const runs = new Map<string, ActiveRun>() // keyed by correlationId

export function registerRun(correlationId: string, sessionId: string, controller: AbortController): void {
  runs.set(correlationId, { correlationId, sessionId, controller })
}

export function unregisterRun(correlationId: string): void {
  runs.delete(correlationId)
}

export function getRun(correlationId: string): ActiveRun | undefined {
  return runs.get(correlationId)
}

/** The most recent in-flight run for a session, if any. */
export function getRunBySession(sessionId: string): ActiveRun | undefined {
  let found: ActiveRun | undefined
  for (const run of runs.values()) {
    if (run.sessionId === sessionId) found = run
  }
  return found
}

/** Abort every in-flight run for a session. Returns how many were aborted. */
export function abortRunsForSession(sessionId: string): number {
  let aborted = 0
  for (const run of [...runs.values()]) {
    if (run.sessionId === sessionId) {
      run.controller.abort()
      runs.delete(run.correlationId)
      aborted++
    }
  }
  return aborted
}
