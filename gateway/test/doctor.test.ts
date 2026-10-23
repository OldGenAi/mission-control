// Run with: npm test
// The doctor: the engine's safety rules with fake checks, and the real checks and fixes against a throwaway database,
// folders and a fake model server.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import type { SettingsSnapshot, SettingsStore } from '../src/store/settings.js'
import type { Check, CheckResult, DoctorContext, DoctorEvent, Fix } from '../src/doctor/types.js'

// Everything reads the home folder at import time, so point it at a throwaway folder first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-doctor-test-'))
process.env['HOME'] = home
process.env['USERPROFILE'] = home

type Mod<T> = T extends Promise<infer M> ? M : never
let db: Database.Database
let engineMod: Mod<ReturnType<typeof importEngine>>
let checksMod: Mod<ReturnType<typeof importChecks>>
const importEngine = () => import('../src/doctor/engine.js')
const importChecks = () => import('../src/doctor/checks.js')

before(async () => {
  const { openDatabase, installFtsTriggers } = await import('../src/store/db.js')
  db = openDatabase(path.join(home, 'test.sqlite'))
  installFtsTriggers(db)
  engineMod = await importEngine()
  checksMod = await importChecks()
})

after(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function fakeSettings(patch: Partial<SettingsSnapshot> = {}): SettingsStore {
  let snap = {
    provider: 'local', localProviderUrl: 'http://127.0.0.1:1/v1', execEnabled: false, comfyUrl: 'http://127.0.0.1:1',
    providerKeys: { openrouter: '', anthropic: '', local: '' }, searchApiKey: '', instances: [], activeInstanceId: null,
    doctorIgnored: [], ...patch,
  } as unknown as SettingsSnapshot
  return {
    get: () => ({ ...snap, providerKeys: { ...snap.providerKeys } }),
    update: (p: Partial<SettingsSnapshot>) => { snap = { ...snap, ...p }; return snap },
  } as unknown as SettingsStore
}

function context(patch: Partial<DoctorContext> = {}): DoctorContext {
  return {
    db, settings: fakeSettings(), dataDir: path.join(home, 'data'), settingsFile: path.join(home, 'data', 'settings.json'),
    logFile: path.join(home, 'data', 'logs', 'gateway.log'), gatewayVersion: '0.2.3', gatewayPort: 4747, gatewayHost: '127.0.0.1',
    appVersion: () => null, ownAddresses: () => [], loopDelayMs: () => 0, uncleanSince: () => null,
    acknowledgeUncleanStart: () => {}, now: () => Date.now(), ...patch,
  }
}

/** A check whose answer the test sets. */
function scripted(id: string, opts: Partial<Check> = {}) {
  let next: CheckResult = { status: 'ok', summary: 'fine' }
  const check: Check = { id, area: 'Gateway', title: `Check ${id}`, ...opts, run: async () => next }
  return { check, set: (r: CheckResult) => { next = r } }
}

function engineWith(checks: Check[], fixes: Record<string, Fix> = {}, ctx = context()) {
  const events: DoctorEvent[] = []
  const engine = new engineMod.DoctorEngine(ctx, checks, fixes, (e) => events.push(e), { checkTimeoutMs: 200 })
  return { engine, events, ctx }
}

describe('engine rules', () => {
  test('an issue shows after two failed checks in a row, and clears when it passes', async () => {
    const a = scripted('a')
    const { engine, events } = engineWith([a.check])
    a.set({ status: 'warn', summary: 'bad' })
    await engine.sweep()
    assert.equal(engine.status().issues.length, 0, 'one miss is not an issue yet')
    await engine.sweep()
    assert.equal(engine.status().issues[0]?.id, 'a')
    assert.equal(engine.status().overall, 'warn')
    a.set({ status: 'ok', summary: 'fine again' })
    await engine.sweep()
    assert.equal(engine.status().issues.length, 0)
    assert.deepEqual(events.filter((e) => e.kind !== 'checked').map((e) => e.kind), ['issue', 'cleared'])
  })

  test('an immediate check shows on the first miss, and fail sorts before warn', async () => {
    const w = scripted('w')
    const f = scripted('f', { immediate: true })
    const { engine } = engineWith([w.check, f.check])
    w.set({ status: 'warn', summary: 'meh' })
    f.set({ status: 'fail', summary: 'broken' })
    await engine.sweep()
    assert.deepEqual(engine.status().issues.map((i) => i.id), ['f'])
    await engine.sweep()
    assert.deepEqual(engine.status().issues.map((i) => i.id), ['f', 'w'])
    assert.equal(engine.status().overall, 'fail')
  })

  test('a check that hangs is reported, not waited on forever', async () => {
    const slow: Check = { id: 'slow', area: 'Gateway', title: 'Slow', immediate: true, run: () => new Promise(() => {}) }
    const { engine } = engineWith([slow])
    await engine.sweep()
    assert.match(engine.status().issues[0]?.summary ?? '', /didn't finish/)
  })

  test('fixes: safe works, approval needs a yes, three per half hour, then it needs you', async () => {
    let applied = 0
    const a = scripted('a', { immediate: true })
    const fixes: Record<string, Fix> = {
      safe: { id: 'safe', tier: 'safe', label: 'Fix', change: 'x', apply: async () => { applied++; return 'done' } },
      ask: { id: 'ask', tier: 'approval', label: 'Change', change: 'turns a setting off', apply: async () => { applied++; return 'changed' } },
    }
    const { engine, events } = engineWith([a.check], fixes)
    a.set({ status: 'fail', summary: 'bad', fix: 'safe' })
    await engine.sweep()
    for (let i = 0; i < 3; i++) assert.equal(await engine.fix('a'), 'done')
    await assert.rejects(engine.fix('a'), (e: Error & { code?: string }) => e.code === 'FIX_LIMIT')
    assert.equal(applied, 3)
    assert.equal(engine.status().issues[0]?.fixesLeft, 0)
    assert.ok(events.some((e) => e.kind === 'fixed'))

    const b = scripted('b', { immediate: true })
    const second = engineWith([b.check], fixes)
    b.set({ status: 'warn', summary: 'shell on', fix: 'ask' })
    await second.engine.sweep()
    await assert.rejects(second.engine.fix('b'), (e: Error & { code?: string }) => e.code === 'NEEDS_APPROVAL' && /turns a setting off/.test(e.message))
    assert.equal(await second.engine.fix('b', true), 'changed')
  })

  test('nothing to fix, no fix, and last-resort fixes are refused', async () => {
    const a = scripted('a', { immediate: true })
    const fixes: Record<string, Fix> = { reset: { id: 'reset', tier: 'last_resort', label: 'Reset', change: 'deletes', apply: async () => 'gone' } }
    const { engine } = engineWith([a.check], fixes)
    await engine.sweep()
    await assert.rejects(engine.fix('a'), (e: Error & { code?: string }) => e.code === 'NO_ISSUE')
    a.set({ status: 'fail', summary: 'bad' })
    await engine.sweep()
    await assert.rejects(engine.fix('a'), (e: Error & { code?: string }) => e.code === 'NO_FIX')
    a.set({ status: 'fail', summary: 'bad', fix: 'reset' })
    await engine.sweep()
    assert.equal(engine.status().issues[0]?.fix, undefined, 'a last-resort fix is never offered')
    await assert.rejects(engine.fix('a'), (e: Error & { code?: string }) => e.code === 'NO_FIX')
    await assert.rejects(engine.fix('nope'), (e: Error & { code?: string }) => e.code === 'UNKNOWN_CHECK')
  })

  test('a failing fix is reported and logged', async () => {
    const a = scripted('a', { immediate: true })
    const fixes: Record<string, Fix> = { boom: { id: 'boom', tier: 'safe', label: 'Fix', change: 'x', apply: async () => { throw new Error('disk full') } } }
    const { engine, events } = engineWith([a.check], fixes)
    a.set({ status: 'fail', summary: 'bad', fix: 'boom' })
    await engine.sweep()
    await assert.rejects(engine.fix('a'), (e: Error & { code?: string }) => e.code === 'FIX_FAILED')
    assert.equal(events.at(-1)?.kind, 'fix_failed')
    assert.equal(engine.history(5).at(-1)?.note, 'disk full')
  })

  test('fix all safe applies only safe fixes', async () => {
    const a = scripted('a', { immediate: true })
    const b = scripted('b', { immediate: true })
    const done: string[] = []
    const fixes: Record<string, Fix> = {
      s: { id: 's', tier: 'safe', label: 'Fix', change: 'x', apply: async () => { done.push('s'); return 'ok' } },
      q: { id: 'q', tier: 'approval', label: 'Ask', change: 'y', apply: async () => { done.push('q'); return 'ok' } },
    }
    const c = scripted('c', { immediate: true })
    fixes['notice'] = { id: 'notice', tier: 'safe', label: 'Got it', change: 'x', oneByOne: true, apply: async () => { done.push('notice'); return 'ok' } }
    const { engine } = engineWith([a.check, b.check, c.check], fixes)
    a.set({ status: 'fail', summary: 'x', fix: 's' })
    b.set({ status: 'fail', summary: 'y', fix: 'q' })
    c.set({ status: 'warn', summary: 'crashed', fix: 'notice' })
    await engine.sweep()
    assert.deepEqual(await engine.fixAllSafe(), { fixed: ['a'], failed: [] })
    assert.deepEqual(done, ['s'], 'approval fixes and one-by-one notices are left for the person')
  })

  test('ignored issues move aside and back, and the choice is saved in settings', async () => {
    const a = scripted('a', { immediate: true })
    const { engine, ctx } = engineWith([a.check])
    a.set({ status: 'warn', summary: 'meh' })
    await engine.sweep()
    engine.ignore('a', true)
    assert.equal(engine.status().issues.length, 0)
    assert.equal(engine.status().ignored[0]?.id, 'a')
    assert.equal(engine.status().overall, 'ok')
    assert.deepEqual(ctx.settings.get().doctorIgnored, ['a'])
    engine.ignore('a', false)
    assert.equal(engine.status().issues[0]?.id, 'a')
  })

  test('secrets never reach the page or the log', async () => {
    const a = scripted('a', { immediate: true })
    const { engine } = engineWith([a.check])
    // Assembled at run time so the source holds no string that looks like a real key (GitHub's secret scanning).
    const fakeKey = ['sk', 'or', 'v1', '0123456789abcdef'.repeat(4)].join('-')
    a.set({ status: 'fail', summary: `key ${fakeKey} was rejected` })
    await engine.sweep()
    assert.doesNotMatch(JSON.stringify(engine.status()), /0123456789abcdef0123/)
    assert.doesNotMatch(JSON.stringify(engine.history(10)), /0123456789abcdef0123/)
  })

  test('a full disk or locked database never takes Mission Control down: the feed still gets the event', async () => {
    const lockedDb = {
      prepare: (sql: string) => (sql.startsWith('INSERT INTO doctor_log') ? { run: () => { throw new Error('database or disk is full') } } : db.prepare(sql)),
    } as unknown as Database.Database
    const a = scripted('a', { immediate: true })
    const { engine, events } = engineWith([a.check], {}, context({ db: lockedDb }))
    a.set({ status: 'fail', summary: 'disk nearly full' })
    await engine.sweep()
    assert.equal(events.at(-2)?.kind, 'issue')
  })

  test('slow checks run every n-th sweep, and "check now" runs everything', async () => {
    let runs = 0
    const slow: Check = { id: 'slow', area: 'Storage', title: 'Slow', everySweeps: 10, run: async () => { runs++; return { status: 'ok', summary: 'ok' } } }
    const { engine } = engineWith([slow])
    for (let i = 0; i < 10; i++) await engine.sweep()
    assert.equal(runs, 1)
    await engine.sweep(true)
    assert.equal(runs, 2)
  })

  test('"check now" during a timer sweep still runs everything once that sweep ends', async () => {
    let slowRuns = 0
    const slow: Check = { id: 'slow', area: 'Storage', title: 'Slow', everySweeps: 10, run: async () => { slowRuns++; return { status: 'ok', summary: 'ok' } } }
    const quick: Check = { id: 'quick', area: 'Gateway', title: 'Quick', run: () => new Promise((r) => setTimeout(() => r({ status: 'ok', summary: 'ok' }), 50)) }
    const { engine } = engineWith([slow, quick])
    await engine.sweep()   // the first sweep runs everything
    const timer = engine.sweep()   // sweep 2: the slow check isn't due
    await engine.sweep(true)
    await timer
    assert.equal(slowRuns, 2)
  })
})

describe('real checks and fixes', () => {
  const check = (id: string) => checksMod.CHECKS.find((c) => c.id === id)!

  test('versionAtLeast compares versions', () => {
    assert.equal(checksMod.versionAtLeast('22.23.4', '22.23.4'), true)
    assert.equal(checksMod.versionAtLeast('v24.22.10', '24.22.9'), true)
    assert.equal(checksMod.versionAtLeast('22.22.2', '22.23.4'), false)
  })

  test('a run with no progress for 10 minutes is found and stopped; a live one is left alone', async () => {
    const now = Date.now()
    const insert = db.prepare(`INSERT INTO pipeline_runs (id, name, status, created_at, updated_at) VALUES (?, 'p', 'running', ?, ?)`)
    insert.run('stuck-1', now - 20 * 60_000, now - 11 * 60_000)
    insert.run('alive-1', now - 20 * 60_000, now - 60_000)
    const ctx = context()
    const found = await check('pipelines.stuck').run(ctx)
    assert.equal(found.status, 'fail')
    assert.match(found.summary, /^1 pipeline run has/)
    assert.equal(await checksMod.FIXES['stop_stuck_runs']!.apply(ctx), 'stopped 1 run')
    const statuses = db.prepare(`SELECT id, status FROM pipeline_runs ORDER BY id`).all()
    assert.deepEqual(statuses, [{ id: 'alive-1', status: 'running' }, { id: 'stuck-1', status: 'failed' }])
    assert.equal((await check('pipelines.stuck').run(ctx)).status, 'ok')
  })

  test('the search index check passes and the rebuild runs', async () => {
    const ctx = context()
    assert.equal((await check('storage.search_index').run(ctx)).status, 'ok')
    assert.equal(await checksMod.FIXES['rebuild_search_index']!.apply(ctx), 'search index rebuilt')
    assert.equal((await check('storage.database').run(ctx)).status, 'ok')
  })

  test('a readable data folder is found and made private', { skip: process.platform === 'win32' }, async () => {
    const ctx = context()
    fs.mkdirSync(ctx.dataDir, { recursive: true, mode: 0o755 })
    fs.chmodSync(ctx.dataDir, 0o755)
    fs.writeFileSync(ctx.settingsFile, '{}', { mode: 0o644 })
    assert.equal((await check('security.data_private').run(ctx)).fix, 'make_private')
    await checksMod.FIXES['make_private']!.apply(ctx)
    assert.equal(fs.statSync(ctx.dataDir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(ctx.settingsFile).mode & 0o777, 0o600)
    assert.equal((await check('security.data_private').run(ctx)).status, 'ok')
  })

  test('the shell tool can be switched off with approval', async () => {
    const ctx = context({ settings: fakeSettings({ execEnabled: true }) })
    await checksMod.FIXES['shell_off']!.apply(ctx)
    assert.equal(ctx.settings.get().execEnabled, false)
  })

  test('the log trim keeps the newest 5 MB and removes old log files', async () => {
    const ctx = context()
    const dir = path.dirname(ctx.logFile)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(ctx.logFile, Buffer.concat([Buffer.alloc(6 * 1024 * 1024, 'a'), Buffer.from('NEWEST')]))
    fs.writeFileSync(`${ctx.logFile}.1`, 'old')
    fs.writeFileSync(path.join(dir, 'other.txt'), 'not a gateway log')
    assert.match(await checksMod.FIXES['trim_logs']!.apply(ctx), /1 old file removed/)
    assert.equal(fs.statSync(ctx.logFile).size, 5 * 1024 * 1024)
    assert.ok(fs.readFileSync(ctx.logFile, 'utf-8').endsWith('NEWEST'))
    assert.ok(!fs.existsSync(`${ctx.logFile}.1`))
    assert.ok(fs.existsSync(path.join(dir, 'other.txt')), 'only gateway logs are touched')
  })

  test('the model source: no server, a server that wants a key, no model loaded, ready', async () => {
    let mode: 'locked' | 'empty' | 'ready' = 'locked'
    const server = http.createServer((req, res) => {
      if (mode === 'locked') { res.writeHead(401); res.end('{}'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: mode === 'ready' ? [{ id: 'qwen' }] : [] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    try {
      assert.equal((await check('models.source').run(context())).status, 'warn', 'nothing on port 1')
      const ctx = context({ settings: fakeSettings({ localProviderUrl: url }) })
      assert.equal((await check('models.source').run(ctx)).status, 'fail')
      mode = 'empty'
      assert.match((await check('models.source').run(ctx)).summary, /no model loaded/)
      mode = 'ready'
      assert.equal((await check('models.source').run(ctx)).status, 'ok')
      const cloud = context({ settings: fakeSettings({ provider: 'openrouter' } as Partial<SettingsSnapshot>) })
      assert.equal((await check('models.source').run(cloud)).status, 'fail', 'OpenRouter without a key')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  test('a model server answering on a network address is flagged with steps', async () => {
    const server = http.createServer((_req, res) => res.end())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      // 127.0.0.1 stands in for "this computer's network address": the server answers there, so it counts as exposed.
      const ctx = context({ ownAddresses: () => ['127.0.0.1'], settings: fakeSettings({ localProviderUrl: `http://127.0.0.1:${port}/v1` }) })
      const result = await check('security.network').run(ctx)
      assert.equal(result.status, 'fail')
      assert.ok(result.steps?.some((s) => s.includes(`port ${port}`)))
      assert.equal((await check('security.network').run(context())).status, 'ok', 'no network addresses: nothing exposed')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  test('a restart waits while something is in progress', async () => {
    const { busyWork } = await import('../src/doctor/index.js')
    db.prepare(`DELETE FROM pipeline_runs`).run()
    assert.deepEqual(busyWork(db), [])
    db.prepare(`INSERT INTO pipeline_runs (id, name, status, created_at, updated_at) VALUES ('busy-1', 'p', 'running', ?, ?)`).run(Date.now(), Date.now())
    assert.deepEqual(busyWork(db), ['1 pipeline run is in progress'])
  })

  test('versions, clean start and a slow gateway', async () => {
    assert.equal((await check('gateway.versions_match').run(context({ appVersion: () => 'v0.2.3' }))).status, 'ok')
    assert.equal((await check('gateway.versions_match').run(context({ appVersion: () => 'v0.2.2' }))).status, 'warn')
    assert.equal((await check('gateway.clean_start').run(context({ uncleanSince: () => Date.now() - 1000 }))).fix, 'acknowledge_unclean')
    assert.equal((await check('gateway.responsive').run(context({ loopDelayMs: () => 900 }))).status, 'warn')
    assert.equal((await check('gateway.responsive').run(context())).status, 'ok')
  })
})
