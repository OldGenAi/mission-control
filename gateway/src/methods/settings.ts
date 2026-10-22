import { registerMethod } from '../router.js'
import { broadcastEvent } from '../broadcast.js'
import type { SettingsStore, SettingsSnapshot, ReasoningEffort } from '../store/settings.js'
import { checkComfyUrl } from '../video/comfyui.js'
import { shellAvailability } from '../tools/shell-policy.js'

/**
 * Mask provider API keys in any settings payload that crosses the wire.
 * Keys are still readable inside the gateway process — this only hides them from the UI.
 */
function maskKeys(s: SettingsSnapshot): SettingsSnapshot {
  return {
    ...s,
    providerKeys: {
      openrouter: s.providerKeys.openrouter ? maskKey(s.providerKeys.openrouter) : '',
      anthropic:  s.providerKeys.anthropic  ? maskKey(s.providerKeys.anthropic)  : '',
      local:      s.providerKeys.local      ? maskKey(s.providerKeys.local)      : '',
    },
    searchApiKey: s.searchApiKey ? maskKey(s.searchApiKey) : '',
  }
}

function maskKey(key: string): string {
  if (key.length < 12) return '••••'
  return `${key.slice(0, 7)}…${key.slice(-4)}`
}

function isValidProvider(v: unknown): v is SettingsSnapshot['provider'] {
  return v === 'local' || v === 'openrouter' || v === 'anthropic'
}

function isValidEffort(v: unknown): v is ReasoningEffort {
  return v === 'low' || v === 'medium' || v === 'high'
}

/**
 * Coerce an unknown patch from the wire into a Partial<SettingsSnapshot>.
 * Silently drops fields with wrong types — never crashes on malformed input.
 * Provider key updates that pass the masked placeholder back are ignored
 * (so re-saving the UI doesn't overwrite the real key with `sk-or-v…ab12`).
 */
function coercePatch(input: Record<string, unknown>, current: SettingsSnapshot): Partial<SettingsSnapshot> {
  const patch: Partial<SettingsSnapshot> = {}
  if (isValidProvider(input['provider']))             patch.provider         = input['provider']
  if (typeof input['defaultModel']     === 'string')  patch.defaultModel     = input['defaultModel']
  if (typeof input['localProviderUrl'] === 'string')  patch.localProviderUrl = input['localProviderUrl']
  if (typeof input['execEnabled']      === 'boolean') patch.execEnabled      = input['execEnabled']
  if (typeof input['thinkingDefault']  === 'boolean') patch.thinkingDefault  = input['thinkingDefault']
  if (isValidEffort(input['reasoningEffort']))        patch.reasoningEffort  = input['reasoningEffort']
  // Only a loopback address is ever stored: the Video page must not send jobs to another machine.
  if (typeof input['comfyUrl'] === 'string' && 'url' in checkComfyUrl(input['comfyUrl'])) patch.comfyUrl = input['comfyUrl']
  if (typeof input['videoFreeAfterJob'] === 'boolean') patch.videoFreeAfterJob = input['videoFreeAfterJob']
  // Search key: ignore the masked placeholder so re-saving the UI doesn't clobber the real key.
  if (typeof input['searchApiKey'] === 'string' && input['searchApiKey'] !== maskKey(current.searchApiKey)) {
    patch.searchApiKey = input['searchApiKey']
  }

  const keys = input['providerKeys']
  if (keys && typeof keys === 'object') {
    const k = keys as Record<string, unknown>
    const keyPatch: Partial<SettingsSnapshot['providerKeys']> = {}
    if (typeof k['openrouter'] === 'string' && k['openrouter'] !== maskKey(current.providerKeys.openrouter)) {
      keyPatch.openrouter = k['openrouter']
    }
    if (typeof k['anthropic'] === 'string' && k['anthropic'] !== maskKey(current.providerKeys.anthropic)) {
      keyPatch.anthropic = k['anthropic']
    }
    if (typeof k['local'] === 'string' && k['local'] !== maskKey(current.providerKeys.local)) {
      keyPatch.local = k['local'].trim()
    }
    if (Object.keys(keyPatch).length > 0) {
      patch.providerKeys = {
        openrouter: keyPatch.openrouter ?? current.providerKeys.openrouter,
        anthropic:  keyPatch.anthropic  ?? current.providerKeys.anthropic,
        local:      keyPatch.local      ?? current.providerKeys.local,
      }
    }
  }
  return patch
}

export function registerSettingsMethods(store: SettingsStore): void {
  registerMethod('settings.get', async () => {
    return { ok: true, settings: maskKeys(store.get()), shell: shellAvailability() }
  })

  registerMethod('settings.update', async (params) => {
    const patch = coercePatch(params, store.get())
    // The setting alone can't turn the shell on: it stays locked until commands can be sandboxed.
    const shell = shellAvailability()
    if (patch.execEnabled === true && !shell.available) {
      return { ok: false, error: `SHELL_LOCKED: ${shell.reason}` }
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: 'NO_VALID_FIELDS: payload contained no recognised settings fields' }
    }
    const next = store.update(patch)
    broadcastEvent('settings.changed', { settings: maskKeys(next) })
    return { ok: true, settings: maskKeys(next) }
  })
}
