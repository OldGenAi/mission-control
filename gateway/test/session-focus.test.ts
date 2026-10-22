// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/store/db.js'
import { registerSessionMethods } from '../src/methods/sessions.js'
import { dispatch } from '../src/router.js'
import { clearFocusedSession, getFocusedSession, setFocusedSession } from '../src/session-focus.js'
import type { ConnectedClient } from '../src/types.js'

const client = {} as ConnectedClient

test('the focused session expires after twelve hours and is replaced by the newest report', () => {
  clearFocusedSession()
  assert.equal(getFocusedSession(), null)
  setFocusedSession('a', 1_000)
  assert.equal(getFocusedSession(1_000 + 60_000), 'a')
  setFocusedSession('b', 2_000)
  assert.equal(getFocusedSession(2_000), 'b')
  assert.equal(getFocusedSession(2_000 + 12 * 60 * 60 * 1000 + 1), null)
  clearFocusedSession()
})

test('sessions.focus / sessions.focused follow the chat the page shows, and ignore chats that do not exist or are in the Trash', async () => {
  clearFocusedSession()
  const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'mc-focus-')), 'db.sqlite'))
  registerSessionMethods(db)
  try {
    const first = (await dispatch('sessions.create', { agentId: 'agent-dave', title: 'one' }, client))['session'] as { id: string }
    const second = (await dispatch('sessions.create', { agentId: 'agent-dave', title: 'two' }, client))['session'] as { id: string }

    assert.deepEqual(await dispatch('sessions.focused', {}, client), { sessionId: null })
    assert.deepEqual(await dispatch('sessions.focus', { sessionId: first.id }, client), { ok: true })
    assert.deepEqual(await dispatch('sessions.focused', {}, client), { sessionId: first.id })
    await dispatch('sessions.focus', { sessionId: second.id }, client)
    assert.deepEqual(await dispatch('sessions.focused', {}, client), { sessionId: second.id })

    assert.deepEqual(await dispatch('sessions.focus', { sessionId: 'nope' }, client), { error: 'no such session' })
    assert.deepEqual(await dispatch('sessions.focus', {}, client), { error: 'sessionId is required' })
    assert.deepEqual(await dispatch('sessions.focused', {}, client), { sessionId: second.id }, 'a refused report changes nothing')

    await dispatch('sessions.delete', { sessionId: second.id }, client)
    assert.deepEqual(await dispatch('sessions.focused', {}, client), { sessionId: null }, 'a chat moved to the Trash is not being looked at')
    assert.deepEqual(await dispatch('sessions.focus', { sessionId: second.id }, client), { error: 'no such session' })
  } finally {
    db.close()
    clearFocusedSession()
  }
})
