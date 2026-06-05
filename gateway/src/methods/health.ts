import type { MethodHandler } from '../types.js'
import type { SettingsStore } from '../store/settings.js'

const startTime = Date.now()

/**
 * Build the health handler. Reads the ACTIVE instance from the settings store
 * at call time so the UI's System Health pills follow live instance switches
 * (e.g. davelocal → Dave OpenRouter). The pre-store version read process.env
 * directly, which silently went stale after the first instance change.
 */
export function makeHealthHandler(settingsStore: SettingsStore): MethodHandler {
  return async () => {
    const s = settingsStore.get()
    const active = s.instances.find(i => i.id === s.activeInstanceId) ?? s.instances[0]
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: '0.1.0',
      timestamp: Date.now(),
      provider: active?.provider ?? s.provider,
      model:    active?.model    ?? s.defaultModel,
    }
  }
}
