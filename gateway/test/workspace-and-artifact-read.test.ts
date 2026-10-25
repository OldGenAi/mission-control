// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/store/db.js'
import { workspacePath } from '../src/store/redact.js'
import { makeArtifactRead } from '../src/tools/artifact.js'

/** A throwaway home folder with a Mission Control install somewhere inside it. */
function fakeHome() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'mc-home-')))
  const install = path.join(home, 'apps', 'mc')
  mkdirSync(install, { recursive: true })
  return { home, install, ws: (env: NodeJS.ProcessEnv, installRoot = install) => workspacePath(env, installRoot, home) }
}

test('MC_WORKSPACE moves the workspace to a folder inside home', () => {
  const { home, ws } = fakeHome()
  assert.equal(ws({}), path.join(home, 'mission-control'))
  assert.equal(ws({ MC_WORKSPACE: path.join(home, 'rodney-workspace') }), path.join(home, 'rodney-workspace'))
  assert.equal(ws({ MC_WORKSPACE: path.join(home, 'a', '..', 'b') }), path.join(home, 'b'))
})

test('MC_WORKSPACE values that would widen the file tools are refused', () => {
  const { home, ws } = fakeHome()
  const fallback = path.join(home, 'mission-control')
  for (const bad of ['relative/dir', home, `${home}${path.sep}`, path.dirname(home), path.parse(home).root, '/etc',
    path.join(home, '.missioncontrol'), path.join(home, '.ssh'), path.join(home, '.config', 'x'), path.join(home, 'x', '..', '..')]) {
    assert.equal(ws({ MC_WORKSPACE: bad }), fallback, bad)
  }
})

test('the workspace never overlaps Mission Control code, running or not', () => {
  const { home, install, ws } = fakeHome()
  const standard = path.join(home, 'mission-control')
  const alt = path.join(home, 'mission-control-workspace')
  // The README's quick start: the running install is ~/mission-control itself.
  assert.equal(ws({}, standard), alt)
  assert.equal(ws({ MC_WORKSPACE: install }), standard)
  assert.equal(ws({ MC_WORKSPACE: path.join(install, 'gateway', 'src', 'pipelines') }), standard)
  // A clone at ~/mission-control that isn't the one running.
  mkdirSync(path.join(home, 'mission-control', 'gateway'), { recursive: true })
  writeFileSync(path.join(home, 'mission-control', 'gateway', 'package.json'), '{}')
  assert.equal(ws({}), alt)
})

test('links are followed before comparing', (t) => {
  const { home, install, ws } = fakeHome()
  try {
    symlinkSync(install, path.join(home, 'link-to-install'), 'dir')
    symlinkSync(install, path.join(home, 'mission-control'), 'dir')
  } catch {
    t.skip('this system does not allow creating symlinks')
    return
  }
  const alt = path.join(home, 'mission-control-workspace')
  assert.equal(ws({}), alt, 'a ~/mission-control that links to the install is not used')
  assert.equal(ws({ MC_WORKSPACE: path.join(home, 'link-to-install') }), alt)
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
