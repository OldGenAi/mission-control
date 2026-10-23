/**
 * methods/onboarding.ts — the first-run "Tell Dave about you" form
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * The person's answers are written into the user entry by the gateway, from a fixed template.
 * No model takes part, so it works the same with any model and nothing an agent reads can
 * change it. (OpenClaw's BOOTSTRAP.md had the model run a multi-step ritual and write its own
 * identity files; this is deliberately the opposite.)
 */

import type Database from 'better-sqlite3'
import { registerMethod } from '../router.js'
import type { SettingsStore } from '../store/settings.js'
import {
  DEFAULT_ASSISTANT_NAME, currentEntry, oldNames, planRename, renameAssistant, replaceName, setEntry, starterIdentity, starterSoul,
} from '../memory/starter-entries.js'
import type { Instance } from '../store/settings.js'

const AGENT_ID = 'tier1_agent'

export type Comfort = 'new' | 'learning' | 'confident'

const COMFORT_TEXT: Record<Comfort, string> = {
  new: 'New to this. Use plain words, explain each step, and check with them before changing anything.',
  learning: 'Getting there. Keep explanations short and check with them before big changes.',
  confident: 'Confident. Be brief, and technical where it helps.',
}

export interface WelcomeAnswers {
  name: string
  location: string
  timeZone: string
  comfort: Comfort
  helpWith: string
  neverTouch: string
  assistantName: string
}

const LIMITS = { name: 60, location: 80, timeZone: 64, helpWith: 400, neverTouch: 400, assistantName: 30 }

/** Trim, drop control characters, and fold line breaks into spaces for one-line fields. */
function clean(value: unknown, max: number, oneLine: boolean): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  let s = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  if (oneLine) s = s.replace(/\s*[\r\n]+\s*/g, ' ')
  s = s.trim()
  return s.length > max ? null : s
}

function isComfort(v: unknown): v is Comfort {
  return v === 'new' || v === 'learning' || v === 'confident'
}

function validTimeZone(tz: string): boolean {
  if (!tz) return true
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function parseWelcome(input: Record<string, unknown>): { ok: true; answers: WelcomeAnswers } | { ok: false; error: string } {
  const name = clean(input['name'], LIMITS.name, true)
  const location = clean(input['location'], LIMITS.location, true)
  const timeZone = clean(input['timeZone'], LIMITS.timeZone, true)
  const helpWith = clean(input['helpWith'], LIMITS.helpWith, false)
  const neverTouch = clean(input['neverTouch'], LIMITS.neverTouch, false)
  const assistantName = clean(input['assistantName'], LIMITS.assistantName, true)
  const comfort = input['comfort']

  const errors: string[] = []
  if (!name) errors.push(`name: required, up to ${LIMITS.name} characters`)
  if (location === null) errors.push(`location: up to ${LIMITS.location} characters`)
  if (timeZone === null || (timeZone && !validTimeZone(timeZone))) errors.push('timeZone: not a recognised time zone')
  if (helpWith === null) errors.push(`helpWith: up to ${LIMITS.helpWith} characters`)
  if (neverTouch === null) errors.push(`neverTouch: up to ${LIMITS.neverTouch} characters`)
  if (assistantName === null) errors.push(`assistantName: up to ${LIMITS.assistantName} characters`)
  if (!isComfort(comfort)) errors.push('comfort: one of new, learning, confident')
  if (errors.length > 0 || !name || !isComfort(comfort)) return { ok: false, error: `INVALID_PARAMS: ${errors.join('; ')}` }

  return {
    ok: true,
    answers: {
      name, location: location ?? '', timeZone: timeZone ?? '', comfort,
      helpWith: helpWith ?? '', neverTouch: neverTouch ?? '', assistantName: assistantName || DEFAULT_ASSISTANT_NAME,
    },
  }
}

export function userEntryFrom(a: WelcomeAnswers): string {
  const lines = [`Name: ${a.name}`]
  if (a.location || a.timeZone) {
    lines.push(`Where they are: ${[a.location, a.timeZone && `time zone ${a.timeZone}`].filter(Boolean).join(', ')}`)
  }
  lines.push(`Comfort with computers: ${COMFORT_TEXT[a.comfort]}`)
  if (a.helpWith) lines.push(`What they want help with: ${a.helpWith}`)
  if (a.neverTouch) lines.push(`Never touch or do: ${a.neverTouch}`)
  return lines.join('\n')
}

/**
 * Saves the answers. A new assistant name replaces "Dave" in the soul and identity only while
 * those are still the untouched starters, so text the person wrote is never overwritten.
 */
export function saveWelcome(db: Database.Database, a: WelcomeAnswers): void {
  setEntry(db, AGENT_ID, 'user', userEntryFrom(a))
  if (a.assistantName === DEFAULT_ASSISTANT_NAME) return
  if (currentEntry(db, AGENT_ID, 'soul') === starterSoul(DEFAULT_ASSISTANT_NAME)) {
    setEntry(db, AGENT_ID, 'soul', starterSoul(a.assistantName))
  }
  if (currentEntry(db, AGENT_ID, 'identity') === starterIdentity(DEFAULT_ASSISTANT_NAME)) {
    setEntry(db, AGENT_ID, 'identity', starterIdentity(a.assistantName))
  }
}

/** A new assistant name from Settings: one line, up to 30 characters, no markdown emphasis (the app strips it when reading), something to show. */
export function parseAssistantName(input: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = clean(input, LIMITS.assistantName, true)?.replace(/[*_`]/g, '').trim()
  if (name === undefined || name === null) return { ok: false, error: `name: up to ${LIMITS.assistantName} characters` }
  if (!/[\p{L}\p{N}]/u.test(name)) return { ok: false, error: 'name: use at least one letter or number' }
  return { ok: true, name }
}

/** Model setups whose name starts a word with an old assistant name take the new one: "Dave", "Dave local" and "davelocal" all follow. */
export function instancesRenamed(instances: Instance[], from: string | readonly string[], to: string): Instance[] {
  return instances.map((i) => ({ ...i, name: replaceName(i.name, from, to, 'start') }))
}

/**
 * Chats keep the title they were given when they started ("davelocal · 10/22 10:40"). Titles that begin with a renamed model
 * setup's old name, or with the old assistant name, follow the rename. Returns the new titles by chat id.
 */
export function chatTitlesRenamed(chats: Array<{ id: string; title: string }>, renames: Array<{ from: string; to: string }>): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = []
  for (const chat of chats) {
    const match = renames.find((r) => chat.title.startsWith(`${r.from} · `))
    if (match) out.push({ id: chat.id, title: `${match.to}${chat.title.slice(match.from.length)}` })
  }
  return out
}

interface RenameChanges {
  from: string
  /** False when the name is the same and there is nothing left over to tidy. */
  changed: boolean
  entries: string[]
  instances: Array<{ from: string; to: string }>
  chats: Array<{ id: string; title: string }>
}

/** Everything a rename would change, so the person can see it before saying yes. Writes nothing. */
function renameChanges(db: Database.Database, settings: SettingsStore, to: string): RenameChanges {
  const plan = planRename(db, AGENT_ID, to)
  const names = oldNames(plan.from, to)
  const current = settings.get().instances
  const renamed = instancesRenamed(current, names, to)
  const instances = current.flatMap((inst, i) => (renamed[i]!.name !== inst.name ? [{ from: inst.name, to: renamed[i]!.name }] : []))
  const chats = chatTitlesRenamed(
    db.prepare<[], { id: string; title: string }>(`SELECT id, title FROM sessions WHERE title IS NOT NULL`).all(),
    [...instances, ...names.map((from) => ({ from, to }))],
  )
  const changed = plan.updates.length > 0 || instances.length > 0 || chats.length > 0
  return { from: plan.from, changed, entries: plan.updates.map((u) => u.key), instances, chats }
}

export function registerOnboardingMethods(db: Database.Database, settings: SettingsStore): void {
  // The form shows only on a fresh install: nobody has filled in the user entry or skipped it.
  registerMethod('onboarding.status', async () => {
    const user = currentEntry(db, AGENT_ID, 'user')
    return { ok: true, needed: !settings.get().welcomeDone && !user?.trim() }
  })

  registerMethod('onboarding.save', async (params) => {
    const parsed = parseWelcome(params as Record<string, unknown>)
    if (!parsed.ok) return parsed
    saveWelcome(db, parsed.answers)
    // The first model setup is named after the assistant, so it follows a new name too (only
    // while it still has the starter name: one the person chose is left alone).
    const name = parsed.answers.assistantName
    const instances = settings.get().instances.map((i) => (i.id === 'default' && i.name === DEFAULT_ASSISTANT_NAME ? { ...i, name } : i))
    settings.update({ welcomeDone: true, instances })
    return { ok: true }
  })

  // Settings > Assistant name. Only the person can reach this (the UI): agents have no tool for it, and the identity entries stay protected from them.
  // With preview: true it only reports what would change, for the confirm box.
  registerMethod('assistant.rename', async (params) => {
    const p = params as Record<string, unknown> | undefined
    const parsed = parseAssistantName(p?.['name'])
    if (!parsed.ok) return parsed
    const to = parsed.name
    const changes = renameChanges(db, settings, to)
    const summary = { from: changes.from, name: to, changed: changes.changed, entries: changes.entries, instances: changes.instances, chats: changes.chats.length }
    if (p?.['preview'] === true || !changes.changed) return { ok: true, ...summary }

    // Instructions and chat titles change together or not at all; the model setups live in the settings file.
    const setTitle = db.prepare<[string, string]>(`UPDATE sessions SET title = ? WHERE id = ?`)
    db.transaction(() => {
      renameAssistant(db, AGENT_ID, to)
      for (const chat of changes.chats) setTitle.run(chat.title, chat.id)
    })()
    settings.update({ instances: instancesRenamed(settings.get().instances, oldNames(changes.from, to), to) })
    return { ok: true, ...summary }
  })

  registerMethod('onboarding.skip', async () => {
    settings.update({ welcomeDone: true })
    return { ok: true }
  })
}
