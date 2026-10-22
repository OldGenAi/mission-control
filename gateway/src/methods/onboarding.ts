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
  DEFAULT_ASSISTANT_NAME, currentEntry, setEntry, starterIdentity, starterSoul,
} from '../memory/starter-entries.js'

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
    settings.update({ welcomeDone: true })
    return { ok: true }
  })

  registerMethod('onboarding.skip', async () => {
    settings.update({ welcomeDone: true })
    return { ok: true }
  })
}
