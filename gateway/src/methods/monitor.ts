import { registerMethod } from '../router.js'
import type { MonitorTracker } from '../monitor.js'

export function registerMonitorMethods(tracker: MonitorTracker): void {
  registerMethod('monitor.subscribe', async (_params, client) => {
    tracker.subscribe(client.id)
    return {
      subscribed: true,
      tick: tracker.currentTick(),
      toolStats: tracker.queryToolStats(),
      sessionStats: tracker.querySessionStats(),
    }
  })

  registerMethod('monitor.unsubscribe', async (_params, client) => {
    tracker.unsubscribe(client.id)
    return { unsubscribed: true }
  })
}
