// Lists, unloads and loads models through LM Studio's own REST API (0.4.0 and newer), for the card sharing
// (card-share.ts). Only the local server's address is contacted, with the key saved for it in Settings.
//
// Security-sensitive. Do not modify without Claude review.

import { isLocalServerUrl } from './local.js'
import { pickLoadConfig, toLoadedModel, type LoadedModel, type ModelServer } from './card-share.js'

const LIST_TIMEOUT_MS = 5_000
const UNLOAD_TIMEOUT_MS = 30_000
const LOAD_TIMEOUT_MS = 180_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** LM Studio's model controls for the local provider's address, or null when that address is not one the provider would use. */
export function lmStudioServer(baseUrl: string, apiKey?: string): ModelServer | null {
  if (!isLocalServerUrl(baseUrl)) return null
  const root = baseUrl.replace(/\/v1\/?$/, '')   // strip the OpenAI-compatible suffix
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }

  async function call(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    try {
      const res = await fetch(`${root}${path}`, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!res.ok) return null
      return await res.json() as unknown
    } catch {
      return null
    }
  }

  return {
    async listLoaded(): Promise<LoadedModel[] | null> {
      const data = await call('GET', '/api/v1/models', undefined, LIST_TIMEOUT_MS)
      if (!isRecord(data) || !Array.isArray(data['models'])) return null
      const loaded: LoadedModel[] = []
      for (const m of data['models']) {
        // Chat models only: embedding models are small, and Mission Control does not load them back.
        if (!isRecord(m) || m['type'] !== 'llm' || !Array.isArray(m['loaded_instances'])) continue
        for (const instance of m['loaded_instances']) {
          if (!isRecord(instance)) continue
          const entry = toLoadedModel({ model: m['key'], instanceId: instance['id'], config: instance['config'] })
          if (entry) loaded.push(entry)
        }
      }
      return loaded
    },

    async unload(instanceId: string): Promise<boolean> {
      if (!toLoadedModel({ model: instanceId, instanceId, config: {} })) return false
      const data = await call('POST', '/api/v1/models/unload', { instance_id: instanceId }, UNLOAD_TIMEOUT_MS)
      return isRecord(data) && data['instance_id'] === instanceId
    },

    async load(m: LoadedModel): Promise<boolean> {
      const entry = toLoadedModel(m)
      if (!entry) return false
      const data = await call('POST', '/api/v1/models/load', { model: entry.model, ...pickLoadConfig(entry.config) }, LOAD_TIMEOUT_MS)
      return isRecord(data) && data['status'] === 'loaded'
    },
  }
}
