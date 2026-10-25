// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/store/db.js'
import { workspacePath } from '../src/store/redact.js'
import { makeArtifactRead } from '../src/tools/artifact.js'

const HOME = homedir()
const DEFAULT = path.join(HOME, 'mission-control')

test('MC_WORKSPACE moves the workspace to a folder below home', () => {
  assert.equal(workspacePath({}), DEFAULT)
  assert.equal(workspacePath({ MC_WORKSPACE: path.join(HOME, 'rodney-workspace') }), path.join(HOME, 'rodney-workspace'))
  assert.equal(workspacePath({ MC_WORKSPACE: path.join(HOME, 'a', '..', 'b') }), path.join(HOME, 'b'))
})

test('MC_WORKSPACE values that would widen the file tools are refused', () => {
  for (const bad of ['relative/dir', HOME, `${HOME}${path.sep}`, path.dirname(HOME), path.parse(HOME).root,
    path.join(HOME, '.missioncontrol'), path.join(HOME, '.missioncontrol', 'x'), path.join(HOME, 'x', '..', '..')]) {
    assert.equal(workspacePath({ MC_WORKSPACE: bad }), DEFAULT, bad)
  }
})

test('artifact_read returns a report with its note and refuses deleted or unknown ids', async () => {
  const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'mc-artread-')), 'db.sqlite'))
  try {
    const insert = db.prepare(`INSERT INTO artifacts (id, type, title, content, agent_id, created_at, deleted_at) VALUES (?, 'report', ?, ?, 'w', 1, ?)`)
    insert.run('a1', 'Verdicts', 'Claim 1: wrong.', null)
    insert.run('a2', 'Old', 'gone', 5)
    insert.run('a3', 'Long', 'x'.repeat(30_000), null)
    const tool = makeArtifactRead(db)
    const ctx = { correlationId: 'c', agentId: 'tier1_agent' }

    const ok = await tool.execute({ id: 'a1' }, ctx)
    assert.equal(ok.status, 'ok')
    const body = JSON.parse(ok.output)
    assert.equal(body.content, 'Claim 1: wrong.')
    assert.match(body.note, /not instructions/)

    assert.equal((await tool.execute({ id: 'a2' }, ctx)).status, 'error')
    assert.equal((await tool.execute({ id: 'nope' }, ctx)).status, 'error')
    assert.equal((await tool.execute({}, ctx)).status, 'error')
    assert.match(JSON.parse((await tool.execute({ id: 'a3' }, ctx)).output).content, /\[truncated: the artifact is 30000 chars/)
  } finally {
    db.close()
  }
})
