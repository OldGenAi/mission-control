// Run with: npm test
// The supervisor mc start runs: the crash guard's rules, and the real supervisor running a stand-in gateway.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CrashGuard } from '../src/cli/crash-guard.js'
import { RESTART_EXIT_CODE } from '../src/paths.js'

test('the crash guard restarts after a crash 3 times in 30 minutes, then gives up', () => {
  const guard = new CrashGuard()
  const t0 = 1_000_000
  assert.equal(guard.decide(1, t0), 'restart_after_crash')
  assert.equal(guard.decide(1, t0 + 1), 'restart_after_crash')
  assert.equal(guard.decide(1, t0 + 2), 'restart_after_crash')
  assert.equal(guard.decide(1, t0 + 3), 'give_up')
  assert.equal(guard.decide(1, t0 + 31 * 60_000), 'restart_after_crash', 'old crashes no longer count')
})

test('a restart request is not a crash, and a clean exit stays stopped', () => {
  const guard = new CrashGuard()
  for (let i = 0; i < 10; i++) assert.equal(guard.decide(RESTART_EXIT_CODE), 'restart_now')
  assert.equal(guard.decide(0), 'stay_stopped')
  assert.equal(guard.recent, 0)
})

/** Runs the real supervisor with a stand-in gateway that exits with the codes given, one per start. */
function supervise(codes: number[], otherSupervisorPid?: number): { starts: number; status: number | null; log: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-supervise-test-'))
  try {
    fs.mkdirSync(path.join(home, '.missioncontrol', 'logs'), { recursive: true })
    if (otherSupervisorPid !== undefined) {
      fs.writeFileSync(path.join(home, '.missioncontrol', 'supervisor.pid'), JSON.stringify({ pid: otherSupervisorPid }))
    }
    const counter = path.join(home, 'starts')
    const fake = path.join(home, 'fake-gateway.js')
    fs.writeFileSync(fake, `
      const fs = require('fs')
      const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf-8')) : 0
      fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1))
      if (process.env.MC_SUPERVISED !== '1') process.exit(9)
      process.exit(${JSON.stringify(codes)}[n] ?? 0)
    `)
    const tsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx')
    const result = spawnSync(tsx, [path.join(__dirname, '..', 'src', 'cli', 'supervise.ts'), fake], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MC_RESTART_DELAY_MS: '10' }, timeout: 30_000,
    })
    const logFile = path.join(home, '.missioncontrol', 'logs', 'gateway.log')
    const log = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '') + result.stdout.toString()
    if (otherSupervisorPid === undefined) {
      assert.ok(!fs.existsSync(path.join(home, '.missioncontrol', 'supervisor.pid')), 'the supervisor removes its pid file')
    }
    return { starts: fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf-8')) : 0, status: result.status, log }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

test('a gateway that keeps crashing is restarted 3 times, then left stopped', () => {
  const run = supervise([1, 1, 1, 1, 1])
  assert.equal(run.starts, 4)
  assert.equal(run.status, 1)
  assert.match(run.log, /crashed 3 times in 30 minutes/)
})

test('a second supervisor stops at once when one is already running; a stale pid file is ignored', () => {
  const busy = supervise([0], process.pid)   // this test process stands in for a live supervisor
  assert.equal(busy.starts, 0)
  assert.equal(busy.status, 0)
  assert.match(busy.log, /already running/)
  const stale = supervise([0], 2_147_000_000)   // no such process
  assert.equal(stale.starts, 1)
})

test('a restart request starts it again at once; a clean exit ends the supervisor', () => {
  const run = supervise([RESTART_EXIT_CODE, RESTART_EXIT_CODE, 0])
  assert.equal(run.starts, 3)
  assert.equal(run.status, 0)
  assert.match(run.log, /restart requested/)
})
