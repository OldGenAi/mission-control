/**
 * providers/unconfigured.ts — stand-in adapter for a provider that has no credentials yet.
 *
 * A fresh install defaults to OpenRouter, which needs a key, and the screen is where the key is
 * entered (Settings → Providers). So the gateway must still start without one. Before this adapter
 * it exited at boot, which left a new user with a dead page and no way to add the key.
 *
 * Chat and pipelines look the live provider up per request (ProviderRegistry), so once a key is saved
 * in the UI the real adapter is used straight away. This adapter is only the boot-time fallback;
 * anything that still reaches it gets a plain-language error as a normal failed completion.
 */

import type { ProviderAdapter, StreamChunk } from './types.js'
import type { ProviderName } from '../store/settings.js'
import type { ProviderRegistry } from './registry.js'

export class UnconfiguredProvider implements ProviderAdapter {
  readonly name: string

  constructor(private readonly wanted: string) {
    this.name = `${wanted} (not set up)`
  }

  async *complete(): AsyncIterable<StreamChunk> {
    const how = this.wanted === 'openrouter'
      ? 'Open Settings → Providers and paste your OpenRouter key, or pick a local model'
      : `Open Settings → Providers and set up "${this.wanted}"`
    yield {
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0 },
      error: `No model source is set up yet for "${this.wanted}". ${how}.`,
    }
  }
}

/** The adapter to use at boot for `wanted`: the real one if it has credentials, otherwise the stand-in. */
export function resolveBootProvider(
  registry: ProviderRegistry,
  wanted: ProviderName,
): { provider: ProviderAdapter; configured: boolean } {
  const real = registry.get(wanted)
  return real ? { provider: real, configured: true } : { provider: new UnconfiguredProvider(wanted), configured: false }
}
