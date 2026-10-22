import { registerMethod } from '../router.js'
import type { MethodHandler } from '../types.js'
import { isLocalServerUrl } from '../providers/local.js'

export type ModelsConfig =
  | { mode: 'local'; baseUrl: string; apiKey?: string }
  | { mode: 'openrouter' }

/**
 * Pass a resolver (not a static config) so models.list follows the ACTIVE instance
 * at call time. Switching instance in the UI then re-lists the right catalogue
 * (LM Studio's loaded models vs OpenRouter's free models) without a gateway restart.
 */
export function registerModelsMethods(resolve: (provider?: string) => ModelsConfig): void {
  const listModels: MethodHandler = async (params) => {
    // Optional `provider` lets a caller (e.g. the pipeline model picker) list a
    // specific provider's catalogue instead of the active instance's.
    const provider = typeof params['provider'] === 'string' ? params['provider'] : undefined
    const config = resolve(provider)
    if (config.mode === 'openrouter') return listOpenRouterModels()
    return listLocalModels(config.baseUrl, config.apiKey)
  }

  registerMethod('models.list', listModels)
}

/** The Authorization header for a local server that requires a key; none when no key is set. */
export function localAuthHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

// Return shape carries diagnostic fields (probedUrl + optional error) so the UI can
// distinguish "still fetching" from "fetched, empty, here's why". The ChatPage
// used to render "Loading…" forever when the local provider port was wrong.
// probedUrl is always set; error is set on any non-2xx or network failure.
// Type alias (not interface) so it satisfies the MethodHandler contract, which
// expects Promise<Record<string, unknown>>. Named interfaces don't carry an
// implicit index signature in TypeScript; type aliases with plain object shapes do.
export type ModelsListResponse = {
  models: Array<{ id: string; label: string; contextLength?: number }>
  probedUrl: string
  error?: string
}

export async function listLocalModels(baseUrl: string, apiKey?: string): Promise<ModelsListResponse> {
  const probedUrl = `${baseUrl}/models`
  try {
    // The key is secret: it is only ever sent to an address the local provider itself would accept, never to whatever the setting says.
    const res = await fetch(probedUrl, { headers: isLocalServerUrl(baseUrl) ? localAuthHeaders(apiKey) : {} })
    if (!res.ok) {
      const needsKey = res.status === 401 || res.status === 403
      const error = `local models endpoint at ${probedUrl} returned HTTP ${res.status}` +
        (needsKey ? ' — the server wants an API key: add it in Settings, Providers, Local provider' : '')
      console.warn(`[models] ${error}`)
      return { models: [], probedUrl, error }
    }
    const data = await res.json() as { data?: Array<{ id: string }> }
    return {
      models: (data.data ?? []).map((m) => ({ id: m.id, label: m.id })),
      probedUrl,
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const error = `could not reach local models endpoint at ${probedUrl} (${detail}). Is your local server (LM Studio / Ollama / llama.cpp) running on that port?`
    console.warn(`[models] ${error}`)
    return { models: [], probedUrl, error }
  }
}

async function listOpenRouterModels(): Promise<ModelsListResponse> {
  const probedUrl = 'https://openrouter.ai/api/v1/models'
  try {
    const res = await fetch(probedUrl)
    if (!res.ok) {
      const error = `OpenRouter models endpoint returned HTTP ${res.status}`
      console.warn(`[models] ${error}`)
      return { models: [], probedUrl, error }
    }
    const data = await res.json() as {
      data?: Array<{ id: string; name?: string; supported_parameters?: string[]; context_length?: number }>
    }
    // Mission Control drives an agentic tool loop, so only tool-capable models are
    // usable here. List both free and paid (paid was previously hidden by a
    // `:free`-only filter); the label flags free ones so paid is a clear choice.
    // context_length feeds the chat's per-model context gauge.
    const models = (data.data ?? [])
      .filter(m => m.supported_parameters?.includes('tools'))
      .map(m => ({
        id:    m.id,
        label: m.id.endsWith(':free') ? `${m.name ?? m.id} (free)` : (m.name ?? m.id),
        contextLength: m.context_length,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return { models, probedUrl }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const error = `could not reach OpenRouter models endpoint (${detail}). Check your network and OPENROUTER_API_KEY.`
    console.warn(`[models] ${error}`)
    return { models: [], probedUrl, error }
  }
}
