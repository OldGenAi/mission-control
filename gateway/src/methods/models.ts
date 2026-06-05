import { registerMethod } from '../router.js'
import type { MethodHandler } from '../types.js'

export type ModelsConfig =
  | { mode: 'local'; baseUrl: string }
  | { mode: 'openrouter' }

/**
 * Pass a resolver (not a static config) so models.list follows the ACTIVE instance
 * at call time. Switching instance in the UI then re-lists the right catalogue
 * (LM Studio's loaded models vs OpenRouter's free models) without a gateway restart.
 */
export function registerModelsMethods(resolve: () => ModelsConfig): void {
  const listModels: MethodHandler = async () => {
    const config = resolve()
    if (config.mode === 'openrouter') return listOpenRouterModels()
    return listLocalModels(config.baseUrl)
  }

  registerMethod('models.list', listModels)
}

async function listLocalModels(baseUrl: string): Promise<{ models: Array<{ id: string; label: string }> }> {
  try {
    const res = await fetch(`${baseUrl}/models`)
    if (!res.ok) {
      console.warn(`[models] local models endpoint returned ${res.status}`)
      return { models: [] }
    }
    const data = await res.json() as { data?: Array<{ id: string }> }
    return {
      models: (data.data ?? []).map((m) => ({ id: m.id, label: m.id })),
    }
  } catch (e) {
    console.warn('[models] failed to fetch local models:', e instanceof Error ? e.message : String(e))
    return { models: [] }
  }
}

async function listOpenRouterModels(): Promise<{ models: Array<{ id: string; label: string }> }> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models')
    if (!res.ok) {
      console.warn(`[models] OpenRouter models endpoint returned ${res.status}`)
      return { models: [] }
    }
    const data = await res.json() as {
      data?: Array<{ id: string; name?: string; supported_parameters?: string[] }>
    }
    // Mission Control drives an agentic tool loop, so only tool-capable models are
    // usable here. List both free and paid (paid was previously hidden by a
    // `:free`-only filter); the label flags free ones so paid is a clear choice.
    const models = (data.data ?? [])
      .filter(m => m.supported_parameters?.includes('tools'))
      .map(m => ({
        id:    m.id,
        label: m.id.endsWith(':free') ? `${m.name ?? m.id} (free)` : (m.name ?? m.id),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return { models }
  } catch (e) {
    console.warn('[models] failed to fetch OpenRouter models:', e instanceof Error ? e.message : String(e))
    return { models: [] }
  }
}
