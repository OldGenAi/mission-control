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
    assert.deepEqual(result, { from: 'Dave', soulKept: false })
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

  test('a soul the person wrote is left alone and reported', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', starters.starterIdentity('Dave'))
    starters.setEntry(db, id, 'soul', 'You are Dave. Be blunt.')
    const result = starters.renameAssistant(db, id, 'Max')
    assert.equal(result.soulKept, true)
    assert.equal(starters.currentEntry(db, id, 'soul'), 'You are Dave. Be blunt.')
  })

  test('the same name changes nothing', () => {
    const id = agent()
    starters.setEntry(db, id, 'identity', starters.starterIdentity('Max'))
    const rows = () => db.prepare('SELECT COUNT(*) AS c FROM memory_entries WHERE agent_id = ?').get(id) as { c: number }
    const before = rows().c
    assert.deepEqual(starters.renameAssistant(db, id, 'Max'), { from: 'Max', soulKept: false })
    assert.equal(rows().c, before)
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
    const out = onboarding.instancesRenamed([inst('a', 'Dave'), inst('b', 'Research')], 'Dave', 'Max')
    assert.deepEqual(out.map((i) => i.name), ['Max', 'Research'])
  })
})
