/**
 * providers/pricing.ts — per-model cost pricing and context-window info.
 *
 * Two things the UI needs that the OpenAI-compatible model list doesn't carry:
 *   - cost: priced from OpenRouter's /models rate card (USD per token).
 *   - context window: the model's *loaded* context size, for the Monitor ring.
 *
 * Cloud (OpenRouter) models get both from one /models fetch. Local models get
 * their loaded context window from whichever local server is running —
 * LM Studio (native /api/v0/models → loaded_context_length) or Ollama
 * (/api/ps → context_length). Everything is cached so the hot path is a sync
 * map lookup; unknown models fall back to safe defaults (cost 0, context 8k).
 */

interface TokenPrice {
  prompt: number      // USD per input token
  completion: number  // USD per output token
}

const priceMap = new Map<string, TokenPrice>()
const ctxMap = new Map<string, number>()   // model id → loaded context window (tokens)
const DEFAULT_CONTEXT = 8192

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

/** OpenRouter rate card → price + context_length for cloud models. */
export async function refreshPricing(): Promise<void> {
  try {
    const res = await fetch(OPENROUTER_MODELS_URL)
    if (!res.ok) {
      console.warn(`[pricing] OpenRouter /models returned ${res.status}`)
      return
    }
    const data = await res.json() as {
      data?: Array<{ id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }>
    }
    let n = 0
    for (const m of data.data ?? []) {
      // OpenRouter prices are strings in USD *per token* (e.g. "0.0000007").
      const prompt = Number(m.pricing?.prompt ?? 0)
      const completion = Number(m.pricing?.completion ?? 0)
      if (Number.isFinite(prompt) && Number.isFinite(completion)) {
        priceMap.set(m.id, { prompt, completion })
        n++
      }
      if (typeof m.context_length === 'number' && m.context_length > 0) {
        ctxMap.set(m.id, m.context_length)
      }
    }
    console.log(`[pricing] loaded ${n} model prices from OpenRouter`)
  } catch (e) {
    console.warn('[pricing] failed to fetch OpenRouter prices:', e instanceof Error ? e.message : String(e))
  }
}

/**
 * Resolve the *loaded* context window of local models. Tries LM Studio's native
 * API first (it reports loaded_context_length — the real window the user loaded
 * the model with), then falls back to Ollama's /api/ps. If neither answers (no
 * local server up, or no model loaded), the defaults apply.
 */
export async function refreshLocalContext(localBaseUrl: string | undefined): Promise<void> {
  if (!localBaseUrl) return
  const root = localBaseUrl.replace(/\/v1\/?$/, '')   // strip the OpenAI-compat suffix

  // LM Studio — native /api/v0/models reports loaded_context_length per model.
  try {
    const res = await fetch(`${root}/api/v0/models`)
    if (res.ok) {
      const data = await res.json() as {
        data?: Array<{ id: string; loaded_context_length?: number; max_context_length?: number }>
      }
      let n = 0
      for (const m of data.data ?? []) {
        const win = m.loaded_context_length ?? m.max_context_length
        if (typeof win === 'number' && win > 0) { ctxMap.set(m.id, win); n++ }
      }
      if (n > 0) { console.log(`[pricing] loaded ${n} LM Studio context window(s)`); return }
    }
  } catch { /* not LM Studio — fall through to Ollama */ }

  // Ollama — /api/ps lists running models with their loaded context_length.
  try {
    const res = await fetch(`${root}/api/ps`)
    if (res.ok) {
      const data = await res.json() as {
        models?: Array<{ name?: string; model?: string; context_length?: number }>
      }
      let n = 0
      for (const m of data.models ?? []) {
        const id = m.model ?? m.name
        if (id && typeof m.context_length === 'number' && m.context_length > 0) {
          ctxMap.set(id, m.context_length); n++
        }
      }
      if (n > 0) console.log(`[pricing] loaded ${n} Ollama context window(s)`)
    }
  } catch { /* no local context source reachable — defaults apply */ }
}

/** USD cost of a single model call. 0 for local/unknown models. */
export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceMap.get(model)
  if (!p) return 0
  return inputTokens * p.prompt + outputTokens * p.completion
}

/** Loaded context window (tokens) for a model, or a safe default. */
export function contextWindow(model: string): number {
  return ctxMap.get(model) ?? DEFAULT_CONTEXT
}

/** Context fill as a 0–100 percentage, for the Monitor ring. */
export function contextPercent(model: string, inputTokens: number): number {
  const win = contextWindow(model)
  if (win <= 0) return 0
  return Math.min(100, Math.round((inputTokens / win) * 100))
}

/**
 * Refresh on startup, then keep both fresh: pricing hourly (rarely changes),
 * local context every 90s (changes when the user loads a different model).
 */
export function startPricingRefresh(getLocalBaseUrl: () => string | undefined): void {
  void refreshPricing()
  void refreshLocalContext(getLocalBaseUrl())
  const priceTimer = setInterval(() => void refreshPricing(), 60 * 60 * 1000)
  const ctxTimer = setInterval(() => void refreshLocalContext(getLocalBaseUrl()), 90 * 1000)
  if (priceTimer.unref) priceTimer.unref()
  if (ctxTimer.unref) ctxTimer.unref()
}
