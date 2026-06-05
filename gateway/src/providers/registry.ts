import type { ProviderAdapter } from './types.js'
import { LocalProvider } from './local.js'
import { OpenRouterProvider } from './openrouter.js'
import type { ProviderName, SettingsSnapshot } from '../store/settings.js'

/**
 * ProviderRegistry — holds one adapter per provider that has valid credentials.
 *
 * Built once at gateway startup from the SettingsStore snapshot. Instances reference
 * providers by name; chat.send / pipelines look up the adapter here instead of
 * relying on a single global. Lets a user run an OpenRouter-backed instance and a
 * local-backed instance in the same gateway process.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, ProviderAdapter>()

  constructor(settings: SettingsSnapshot) {
    this.rebuild(settings)
  }

  /**
   * (Re)build the adapter map from the current settings snapshot. Called at boot and
   * again on every settings change (wired via SettingsStore.subscribe in index.ts), so
   * a UI key/URL edit takes effect on the next request with no gateway restart.
   */
  rebuild(settings: SettingsSnapshot): void {
    this.providers.clear()
    // Local provider always available — has no auth requirement.
    this.providers.set('local', new LocalProvider({ baseUrl: settings.localProviderUrl }))

    if (settings.providerKeys.openrouter) {
      this.providers.set('openrouter', new OpenRouterProvider({ apiKey: settings.providerKeys.openrouter }))
    }
    // Anthropic adapter not wired in this build — when added, instantiate here.
  }

  get(name: ProviderName): ProviderAdapter | null {
    return this.providers.get(name) ?? null
  }

  has(name: ProviderName): boolean {
    return this.providers.has(name)
  }

  names(): ProviderName[] {
    return Array.from(this.providers.keys())
  }
}
