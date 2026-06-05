/**
 * failure-tracker.ts — consecutive tool-failure containment
 *
 * Shared by the chat loop (loop.ts) and the headless worker loop
 * (worker-loop.ts). A run of failing tool calls — blind file_read guessing,
 * or an orchestrator re-spawning a worker that keeps 429'ing — is stopped
 * after `limit` consecutive failures, well before the iteration cap or the
 * wall-clock deadline. A single success resets the count, so an isolated
 * transient failure never trips it; only a genuinely failing loop does.
 */

const MAX_CONSECUTIVE_TOOL_FAILURES = 3

export class ConsecutiveFailureTracker {
  private failures = 0
  private lastErrorMessage: string | undefined

  constructor(readonly limit: number = MAX_CONSECUTIVE_TOOL_FAILURES) {}

  record(status: 'ok' | 'error', error?: string): void {
    if (status === 'error') {
      this.failures++
      this.lastErrorMessage = error
    } else {
      this.failures = 0
    }
  }

  get tripped(): boolean {
    return this.failures >= this.limit
  }

  get lastError(): string | undefined {
    return this.lastErrorMessage
  }
}
