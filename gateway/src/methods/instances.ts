import { randomUUID } from 'node:crypto'
import { registerMethod } from '../router.js'
import { broadcastEvent } from '../broadcast.js'
import type { SettingsStore, Instance, ProviderName } from '../store/settings.js'
import type { ProviderRegistry } from '../providers/registry.js'

function isValidProvider(v: unknown): v is ProviderName {
  return v === 'local' || v === 'openrouter' || v === 'anthropic'
}

export function registerInstancesMethods(store: SettingsStore, providers: ProviderRegistry): void {
  registerMethod('instances.list', async () => {
    const s = store.get()
    return {
      ok: true,
      instances: s.instances,
      activeInstanceId: s.activeInstanceId,
      availableProviders: providers.names(),
    }
  })

  registerMethod('instances.create', async (params) => {
    const name     = params['name']
    const provider = params['provider']
    const model    = params['model']
    const type     = params['type'] === 'pipeline' ? 'pipeline' : 'chat'
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'INSTANCE_NAME_REQUIRED' }
    if (!isValidProvider(provider))               return { ok: false, error: 'INSTANCE_PROVIDER_INVALID' }
    if (typeof model !== 'string' || !model.trim()) return { ok: false, error: 'INSTANCE_MODEL_REQUIRED' }
    if (!providers.has(provider))                  return { ok: false, error: `INSTANCE_PROVIDER_UNAVAILABLE: gateway has no credentials configured for "${provider}"` }

    const next: Instance = { id: randomUUID(), name: name.trim(), provider, model: model.trim(), type }
    const current = store.get()
    store.update({ instances: [...current.instances, next] })
    broadcastEvent('settings.changed', { settings: store.get() })
    return { ok: true, instance: next }
  })

  registerMethod('instances.update', async (params) => {
    const id = params['id']
    if (typeof id !== 'string') return { ok: false, error: 'INSTANCE_ID_REQUIRED' }
    const current = store.get()
    const idx = current.instances.findIndex(i => i.id === id)
    if (idx === -1) return { ok: false, error: 'INSTANCE_NOT_FOUND' }

    const patched: Instance = { ...current.instances[idx] }
    if (typeof params['name']  === 'string' && params['name'].trim())  patched.name  = params['name'].trim()
    if (isValidProvider(params['provider'])) {
      if (!providers.has(params['provider'])) return { ok: false, error: `INSTANCE_PROVIDER_UNAVAILABLE: "${params['provider']}" has no credentials` }
      patched.provider = params['provider']
    }
    if (typeof params['model'] === 'string' && params['model'].trim()) patched.model = params['model'].trim()
    if (params['type'] === 'chat' || params['type'] === 'pipeline') patched.type = params['type']

    const nextList = [...current.instances]
    nextList[idx] = patched
    store.update({ instances: nextList })
    broadcastEvent('settings.changed', { settings: store.get() })
    return { ok: true, instance: patched }
  })

  registerMethod('instances.delete', async (params) => {
    const id = params['id']
    if (typeof id !== 'string') return { ok: false, error: 'INSTANCE_ID_REQUIRED' }
    const current = store.get()
    if (current.instances.length <= 1) return { ok: false, error: 'INSTANCE_LAST_REMAINING: cannot delete the only instance' }
    const next = current.instances.filter(i => i.id !== id)
    if (next.length === current.instances.length) return { ok: false, error: 'INSTANCE_NOT_FOUND' }
    const activeId = current.activeInstanceId === id ? next[0].id : current.activeInstanceId
    store.update({ instances: next, activeInstanceId: activeId })
    broadcastEvent('settings.changed', { settings: store.get() })
    return { ok: true }
  })

  registerMethod('instances.setActive', async (params) => {
    const id = params['id']
    if (typeof id !== 'string') return { ok: false, error: 'INSTANCE_ID_REQUIRED' }
    const current = store.get()
    if (!current.instances.some(i => i.id === id)) return { ok: false, error: 'INSTANCE_NOT_FOUND' }
    store.update({ activeInstanceId: id })
    broadcastEvent('settings.changed', { settings: store.get() })
    return { ok: true, activeInstanceId: id }
  })
}
