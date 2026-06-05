/**
 * session-lock.ts — per-session mutex.
 *
 * Both user-initiated chat.send turns and proactive pipeline-completion
 * notifications must acquire the lock for a given sessionId before running
 * Dave's loop. Without this, a pipeline finishing during an active chat turn
 * would corrupt the message history (two writers, same session).
 *
 * Lock is await-style: callers await `acquireSessionLock()` to get a release
 * function, then call `release()` when done. FIFO ordering — earliest await wins.
 */

const tails = new Map<string, Promise<void>>()

export async function acquireSessionLock(sessionId: string): Promise<() => void> {
  const prev = tails.get(sessionId) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<void>(resolve => { release = resolve })
  // The new tail is "current holder finishing" = prev.then(() => next); the next caller
  // chains off it. When this tail settles (release called) and nobody chained after us,
  // drop the entry — otherwise the map grows one permanent slot per session for the
  // gateway's lifetime.
  const tail = prev.then(() => next)
  tails.set(sessionId, tail)
  void tail.finally(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId) })
  await prev
  return release
}
