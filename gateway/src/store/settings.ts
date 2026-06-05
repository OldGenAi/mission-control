import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import path from 'node:path'
import { getConfig } from '../auth.js'

export type ReasoningEffort = 'low' | 'medium' | 'high'
export type ProviderName    = 'local' | 'openrouter' | 'anthropic'

export interface Instance {
  id:        string
  name:      string
  provider:  ProviderName
  model:     string
}

export interface SettingsSnapshot {
  provider:        ProviderName
  defaultModel:    string
  localProviderUrl: string
  execEnabled:     boolean
  thinkingDefault: boolean
  reasoningEffort: ReasoningEffort
  providerKeys: {
    openrouter: string
    anthropic:  string
  }
  searchApiKey:     string   // Brave Search key for web_search (was env-only)
  instances:        Instance[]
  activeInstanceId: string | null
}

interface SettingsFile {
  version: 1
  settings: SettingsSnapshot
}

const FILE_VERSION = 1
const DEFAULTS: SettingsSnapshot = {
  provider:         'local',
  defaultModel:     'local-model',
  localProviderUrl: 'http://127.0.0.1:1234/v1',
  execEnabled:      false,
  thinkingDefault:  false,
  reasoningEffort:  'medium',
  providerKeys: { openrouter: '', anthropic: '' },
  searchApiKey:     '',
  instances:        [],
  activeInstanceId: null,
}

// ── At-rest encryption for the secret fields ──────────────────────────────────
// settings.json holds API keys. They're owner-only (0600), and we also encrypt them at
// rest (AES-256-GCM) so the file is useless if it's ever copied/synced/backed up WITHOUT
// config.json (which holds the key). Format: enc:v1:<iv>:<tag>:<ciphertext> (base64). Empty
// values and legacy plaintext pass through — an older file migrates on its next write.
const ENC_PREFIX = 'enc:v1:'

function encryptSecret(plaintext: string | undefined, keyHex: string): string {
  if (!plaintext) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

function decryptSecret(stored: string | undefined, keyHex: string): string {
  if (!stored) return ''
  if (!stored.startsWith(ENC_PREFIX)) return stored   // legacy plaintext — migrates on next write
  try {
    const [ivB64, tagB64, ctB64] = stored.slice(ENC_PREFIX.length).split(':')
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivB64 ?? '', 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64 ?? '', 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64 ?? '', 'base64')), decipher.final()]).toString('utf8')
  } catch {
    console.warn('[settings] could not decrypt a stored key (lost/rotated encryption key?) — treating as unset; re-enter it in Settings → Providers')
    return ''
  }
}

export class SettingsStore {
  private snapshot: SettingsSnapshot
  private readonly filePath: string
  private readonly listeners = new Set<(s: SettingsSnapshot) => void>()

  constructor(filePath: string, envOverrides: Partial<SettingsSnapshot> = {}) {
    this.filePath = filePath
    const dir = path.dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })

    const loaded = this.loadFromDisk()   // raw — secret fields may still be encrypted
    if (loaded) {
      // Disk wins after first boot — user edits are authoritative. Decrypt the secret fields.
      this.snapshot = { ...DEFAULTS, ...this.mapSecrets(loaded, decryptSecret) }
      // One-time backfill for fields added after this install was created. Presence is checked
      // on the RAW loaded object (before decryption normalises undefined→''), so we adopt a
      // pre-existing env key (e.g. SEARCH_API_KEY) only when the field was truly ABSENT —
      // never resurrecting one the user cleared in the UI.
      if (loaded.searchApiKey === undefined && envOverrides.searchApiKey) {
        this.snapshot.searchApiKey = envOverrides.searchApiKey
      }
    } else {
      // First boot — seed from env.
      this.snapshot = {
        ...DEFAULTS,
        ...envOverrides,
        providerKeys: { ...DEFAULTS.providerKeys, ...(envOverrides.providerKeys ?? {}) },
      }
    }

    // Ensure at least one instance exists — backfill from current provider/model so
    // existing installs upgrade cleanly without an empty Instances panel.
    if (this.snapshot.instances.length === 0) {
      const seed: Instance = {
        id:       'default',
        name:     'Dave',
        provider: this.snapshot.provider,
        model:    this.snapshot.defaultModel,
      }
      this.snapshot.instances = [seed]
      this.snapshot.activeInstanceId = seed.id
    } else if (!this.snapshot.activeInstanceId || !this.snapshot.instances.some(i => i.id === this.snapshot.activeInstanceId)) {
      this.snapshot.activeInstanceId = this.snapshot.instances[0].id
    }

    // Single write: canonical on-disk form — secret keys AES-256-GCM encrypted at rest, file
    // 0600. Also migrates an older plaintext file and persists any first-boot seed / backfill.
    this.persist()
  }

  get(): SettingsSnapshot {
    return { ...this.snapshot, providerKeys: { ...this.snapshot.providerKeys } }
  }

  /**
   * Patch one or more fields. Returns the new snapshot. Persists to disk + notifies listeners.
   * Rejects unknown keys to keep the file schema clean.
   */
  update(patch: Partial<SettingsSnapshot>): SettingsSnapshot {
    const next: SettingsSnapshot = {
      ...this.snapshot,
      ...patch,
      providerKeys: { ...this.snapshot.providerKeys, ...(patch.providerKeys ?? {}) },
    }
    this.snapshot = next
    this.persist()
    for (const l of this.listeners) l(this.get())
    return this.get()
  }

  subscribe(fn: (s: SettingsSnapshot) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private loadFromDisk(): SettingsSnapshot | null {
    if (!existsSync(this.filePath)) return null
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as SettingsFile
      if (parsed.version !== FILE_VERSION) {
        console.warn(`[settings] file version ${parsed.version} != ${FILE_VERSION}, using defaults`)
        return null
      }
      return parsed.settings
    } catch (e) {
      console.warn('[settings] failed to load, using defaults:', e instanceof Error ? e.message : e)
      return null
    }
  }

  // Apply a transform (encrypt or decrypt) to just the secret-bearing fields, leaving the
  // rest of the snapshot untouched.
  private mapSecrets(s: SettingsSnapshot, fn: (v: string | undefined, keyHex: string) => string): SettingsSnapshot {
    const keyHex = getConfig().encryptionKey
    const pk = s.providerKeys ?? { openrouter: '', anthropic: '' }
    return {
      ...s,
      providerKeys: { openrouter: fn(pk.openrouter, keyHex), anthropic: fn(pk.anthropic, keyHex) },
      searchApiKey: fn(s.searchApiKey, keyHex),
    }
  }

  private persist(): void {
    // Encrypt the secret fields at rest, then write owner-only (0600). chmod re-applies on an
    // existing file (writeFileSync's mode only takes effect on creation). Best-effort on non-POSIX FS.
    const file: SettingsFile = { version: FILE_VERSION, settings: this.mapSecrets(this.snapshot, encryptSecret) }
    writeFileSync(this.filePath, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(this.filePath, 0o600) } catch { /* perms not enforceable on this filesystem */ }
  }
}

/**
 * Build envOverrides from process.env. Used at gateway startup so users on first
 * boot get whatever they've set in .env without having to re-enter it in the UI.
 * After first boot, the disk file is the source of truth — env is ignored.
 */
export function envOverrides(): Partial<SettingsSnapshot> {
  const out: Partial<SettingsSnapshot> = {}
  const provider = process.env['PROVIDER']
  if (provider === 'local' || provider === 'openrouter' || provider === 'anthropic') {
    out.provider = provider
  }
  if (process.env['DEFAULT_MODEL']) out.defaultModel = process.env['DEFAULT_MODEL']
  if (process.env['LOCAL_PROVIDER_URL']) out.localProviderUrl = process.env['LOCAL_PROVIDER_URL']
  if (process.env['SEARCH_API_KEY']) out.searchApiKey = process.env['SEARCH_API_KEY']
  const keys: Partial<SettingsSnapshot['providerKeys']> = {}
  if (process.env['OPENROUTER_API_KEY']) keys.openrouter = process.env['OPENROUTER_API_KEY']
  if (process.env['ANTHROPIC_API_KEY'])  keys.anthropic  = process.env['ANTHROPIC_API_KEY']
  if (Object.keys(keys).length > 0) out.providerKeys = { openrouter: '', anthropic: '', ...keys }
  return out
}
