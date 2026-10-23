// Run with: npm test
// Renaming the assistant from Settings: the identity name line, the starter soul, the name rules and the model setups.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { Instance } from '../src/store/settings.js'

// Everything reads the home folder at import time, so point it at a throwaway folder first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rename-test-'))
process.env['HOME'] = home
process.env['USERPROFILE'] = home

type Mod<T> = T extends Promise<infer M> ? M : never
let db: Database.Database
let starters: Mod<ReturnType<typeof importStarters>>
let onboarding: Mod<ReturnType<typeof importOnboarding>>

const importStarters = () => import('../src/memory/starter-entries.js')
const importOnboarding = () => import('../src/methods/onboarding.js')

let n = 0
const agent = () => `rename_agent_${++n}`

before(async () => {
  const { openDatabase } = await import('../src/store/db.js')
  db = openDatabase(path.join(home, 'test.sqlite'))
  starters = await importStarters()
  onboarding = await importOnboarding()
})

after(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('renameAssistant', () => {
  test('untouched starters are rewritten for the new name', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', starters.starterIdentity('Dave'))
    starters.setEntry(db, id, 'soul', starters.starterSoul('Dave'))
    const result = starters.renameAssistant(db, id, 'Cherry')
    assert.equal(result.from, 'Dave')
    assert.deepEqual(result.updates.map((u) => u.key), ['identity', 'soul'])
    assert.equal(starters.currentEntry(db, id, 'identity'), starters.starterIdentity('Cherry'))
    assert.equal(starters.currentEntry(db, id, 'soul'), starters.starterSoul('Cherry'))
  })

  test('an identity the person edited keeps their text and changes only the name line', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', '- **Name:** Dave\n- **Vibe:** Sharp and dry')
    starters.renameAssistant(db, id, 'Max')
    assert.equal(starters.currentEntry(db, id, 'identity'), '- **Name:** Max\n- **Vibe:** Sharp and dry')
  })

  test('a name with replacement patterns is written literally', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', 'Name: Dave\nRole: helper')
    starters.renameAssistant(db, id, "A$&B$1'")
    assert.equal(starters.currentEntry(db, id, 'identity'), "Name: A$&B$1'\nRole: helper")
  })

  test('an identity with no name line gets one on top', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', 'Role: helper')
    const result = starters.renameAssistant(db, id, 'Max')
    assert.equal(result.from, 'Dave')
    assert.equal(starters.currentEntry(db, id, 'identity'), 'Name: Max\nRole: helper')
  })

  test('no identity at all writes the starter', () => {
    const id = agent()
    starters.renameAssistant(db, id, 'Max')
    assert.equal(starters.currentEntry(db, id, 'identity'), starters.starterIdentity('Max'))
  })

  test('text the person wrote takes the new name where the old one is a whole word', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', '# IDENTITY.md\n- **Name:** Dave\n- Dave keeps notes')
    starters.setEntry(db, id, 'soul', 'You are Dave. Be blunt. Davenport is a town. DAVE stays.')
    starters.setEntry(db, id, 'agents', 'Dave asks before deleting.')
    starters.setEntry(db, id, 'user', 'Name: JB\nLikes Dave')
    starters.renameAssistant(db, id, 'Rodney')
    assert.equal(starters.currentEntry(db, id, 'identity'), '# IDENTITY.md\n- **Name:** Rodney\n- Rodney keeps notes')
    assert.equal(starters.currentEntry(db, id, 'soul'), 'You are Rodney. Be blunt. Davenport is a town. DAVE stays.')
    assert.equal(starters.currentEntry(db, id, 'agents'), 'Rodney asks before deleting.')
    assert.equal(starters.currentEntry(db, id, 'user'), 'Name: JB\nLikes Dave', 'the user entry is about the person')
  })

  test('the old wording stays as history', () => {
    const id = agent()
    starters.setEntry(db, id, 'soul', 'You are Dave.')
    starters.renameAssistant(db, id, 'Max')
    const old = db.prepare('SELECT content FROM memory_entries WHERE agent_id = ? AND key = ? AND valid_until IS NOT NULL').get(id, 'soul') as { content: string }
    assert.equal(old.content, 'You are Dave.')
  })

  test('planRename writes nothing', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', starters.starterIdentity('Dave'))
    const plan = starters.planRename(db, id, 'Max')
    assert.deepEqual(plan.updates.map((u) => u.key), ['identity'])
    assert.equal(starters.currentEntry(db, id, 'identity'), starters.starterIdentity('Dave'))
  })

  test('saving the same name again tidies up a leftover Dave', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', 'Name: Rodney')
    starters.setEntry(db, id, 'soul', 'You are Dave.')
    const plan = starters.renameAssistant(db, id, 'Rodney')
    assert.deepEqual(plan.updates.map((u) => u.key), ['soul'])
    assert.equal(starters.currentEntry(db, id, 'soul'), 'You are Rodney.')
  })

  test('the same name changes nothing', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', starters.starterIdentity('Max'))
    const rows = () => db.prepare('SELECT COUNT(*) AS c FROM memory_entries WHERE agent_id = ?').get(id) as { c: number }
    const before = rows().c
    assert.deepEqual(starters.renameAssistant(db, id, 'Max'), { from: 'Max', updates: [] })
    assert.equal(rows().c, before)
  })
})

describe('replaceName', () => {
  test('word mode: the exact name as a whole word only', () => {
    assert.equal(starters.replaceName('Max said max 3 tries, Maxine', 'Max', 'Bo', 'word'), 'Bo said max 3 tries, Maxine')
  })

  test('start mode: any case at the start of a word, written in the case found', () => {
    assert.equal(starters.replaceName('davelocal', 'Dave', 'Rodney', 'start'), 'rodneylocal')
    assert.equal(starters.replaceName('Dave local', 'Dave', 'Rodney', 'start'), 'Rodney local')
    assert.equal(starters.replaceName('DAVE-2', 'Dave', 'Rodney', 'start'), 'RODNEY-2')
    assert.equal(starters.replaceName('my dave', 'Dave', 'Rodney', 'start'), 'my rodney')
    assert.equal(starters.replaceName('Research', 'Dave', 'Rodney', 'start'), 'Research')
  })

  test('one pass, so a new name containing the old one is not replaced again', () => {
    assert.equal(starters.replaceName('You are Dave.', 'Dave', 'Dave Jr', 'word'), 'You are Dave Jr.')
  })

  test('names with pattern characters are matched and written literally', () => {
    assert.equal(starters.replaceName('Hi A.B, not AxB', 'A.B', "$&'", 'word'), "Hi $&', not AxB")
  })
})

describe('parseAssistantName', () => {
  test('accepts a plain name and trims it', () => {
    assert.deepEqual(onboarding.parseAssistantName('  Cherry  '), { ok: true, name: 'Cherry' })
  })

  test('strips markdown emphasis characters', () => {
    assert.deepEqual(onboarding.parseAssistantName('**Che_rry**'), { ok: true, name: 'Cherry' })
  })

  test('folds a line break into a space, so the identity stays one line', () => {
    assert.deepEqual(onboarding.parseAssistantName('Cherry\nRole: boss'), { ok: true, name: 'Cherry Role: boss' })
  })

  test('refuses more than 30 characters, a non-string, empty and symbol-only names', () => {
    assert.equal(onboarding.parseAssistantName('x'.repeat(31)).ok, false)
    assert.equal(onboarding.parseAssistantName(42).ok, false)
    assert.equal(onboarding.parseAssistantName('').ok, false)
    assert.equal(onboarding.parseAssistantName('***').ok, false)
    assert.equal(onboarding.parseAssistantName('x'.repeat(30)).ok, true)
  })
})

describe('instancesRenamed', () => {
  const inst = (id: string, name: string): Instance => ({ id, name, provider: 'local', model: 'm' })

  test('setups carrying the old name take the new one; the others stay', () => {
    const out = onboarding.instancesRenamed([inst('a', 'Dave'), inst('b', 'Research'), inst('c', 'davelocal'), inst('d', 'Dave OpenRouter')], 'Dave', 'Max')
    assert.deepEqual(out.map((i) => i.name), ['Max', 'Research', 'maxlocal', 'Max OpenRouter'])
  })

  test('a leftover Dave follows too', () => {
    const out = onboarding.instancesRenamed([inst('a', 'Rodney'), inst('b', 'davelocal')], starters.oldNames('Rodney', 'Rodney'), 'Rodney')
    assert.deepEqual(out.map((i) => i.name), ['Rodney', 'rodneylocal'])
  })
})

describe('chatTitlesRenamed', () => {
  test('titles that begin with a renamed name follow it; others stay', () => {
    const chats = [
      { id: '1', title: 'davelocal · 10/22 10:40' },
      { id: '2', title: 'Dave · 10/21 09:00' },
      { id: '3', title: 'Trip planning' },
      { id: '4', title: 'davelocal notes' },
    ]
    const out = onboarding.chatTitlesRenamed(chats, [{ from: 'davelocal', to: 'rodneylocal' }, { from: 'Dave', to: 'Rodney' }])
    assert.deepEqual(out, [{ id: '1', title: 'rodneylocal · 10/22 10:40' }, { id: '2', title: 'Rodney · 10/21 09:00' }])
  })
})

describe('loadSystemPrompt', () => {
  test('the built-in spec uses the chosen name', async () => {
    const { loadSystemPrompt } = await import('../src/memory/loader.js')
    starters.setEntry(db, 'tier1_agent', 'identity', starters.starterIdentity('Rodney'))
    const prompt = loadSystemPrompt(db, 'tier1_agent')
    assert.match(prompt, /Rodney is the user's personal AI agent/)
    assert.doesNotMatch(prompt, /\bDave\b/)
  })
})
