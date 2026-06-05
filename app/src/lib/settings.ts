import { useEffect, useState, useCallback } from 'react'
import { gateway } from './gateway-client'

export type ReasoningEffort = 'low' | 'medium' | 'high'
export type ProviderName    = 'local' | 'openrouter' | 'anthropic'

export interface Instance {
  id:       string
  name:     string
  provider: ProviderName
  model:    string
}

export interface SettingsSnapshot {
  provider:         ProviderName
  defaultModel:     string
  localProviderUrl: string
  execEnabled:      boolean
  thinkingDefault:  boolean
  reasoningEffort:  ReasoningEffort
  providerKeys: {
    openrouter: string  // masked when read (e.g. "sk-or-v…ab12") — empty string when unset
    anthropic:  string
  }
  searchApiKey:     string  // masked when read — Brave Search key for web_search
  instances:        Instance[]
  activeInstanceId: string | null
}

export interface InstancesListResponse {
  ok:                 boolean
  instances:          Instance[]
  activeInstanceId:   string | null
  availableProviders: ProviderName[]
}

export async function listInstances(): Promise<InstancesListResponse | null> {
  try { return await gateway.request<InstancesListResponse>('instances.list', {}) } catch { return null }
}

export async function createInstance(name: string, provider: ProviderName, model: string): Promise<Instance | null> {
  try {
    const r = await gateway.request<{ ok: boolean; instance?: Instance; error?: string }>('instances.create', { name, provider, model })
    return r.ok && r.instance ? r.instance : null
  } catch { return null }
}

export async function deleteInstance(id: string): Promise<boolean> {
  try {
    const r = await gateway.request<{ ok: boolean }>('instances.delete', { id })
    return r.ok
  } catch { return false }
}

export async function setActiveInstance(id: string): Promise<boolean> {
  try {
    const r = await gateway.request<{ ok: boolean }>('instances.setActive', { id })
    return r.ok
  } catch { return false }
}

export async function updateInstance(id: string, patch: Partial<Pick<Instance, 'name' | 'provider' | 'model'>>): Promise<Instance | null> {
  try {
    const r = await gateway.request<{ ok: boolean; instance?: Instance }>('instances.update', { id, ...patch })
    return r.ok && r.instance ? r.instance : null
  } catch { return null }
}

interface SettingsResponse {
  ok: boolean
  settings?: SettingsSnapshot
  error?: string
}

export async function fetchSettings(): Promise<SettingsSnapshot | null> {
  try {
    const r = await gateway.request<SettingsResponse>('settings.get', {})
    return r.settings ?? null
  } catch {
    return null
  }
}

export async function updateSettings(patch: Partial<SettingsSnapshot>): Promise<SettingsSnapshot | null> {
  try {
    const r = await gateway.request<SettingsResponse>('settings.update', patch as Record<string, unknown>)
    if (!r.ok) return null
    return r.settings ?? null
  } catch {
    return null
  }
}

/**
 * useSettings — subscribe to the gateway's settings.changed broadcast and stay live.
 * Re-renders any component that uses it when another tab updates settings.
 */
export function useSettings(): { settings: SettingsSnapshot | null; reload: () => Promise<void> } {
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null)

  const reload = useCallback(async () => {
    const s = await fetchSettings()
    if (s) setSettings(s)
  }, [])

  useEffect(() => {
    reload()
    const unsub = gateway.onEvent(e => {
      if (e.event === 'settings.changed' && e.payload && typeof e.payload === 'object') {
        const next = (e.payload as { settings?: SettingsSnapshot }).settings
        if (next) setSettings(next)
      }
    })
    return unsub
  }, [reload])

  return { settings, reload }
}
