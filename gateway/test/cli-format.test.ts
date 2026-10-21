// Run with: npm test
// Spec for src/cli/format.ts: pure text formatting for `mc status`, `mc doctor` and `mc help`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatUptime, formatStatus, formatDoctor, helpText } from '../src/cli/format.js'

test('uptime reads like a person would say it', () => {
  assert.equal(formatUptime(0), '0s')
  assert.equal(formatUptime(59), '59s')
  assert.equal(formatUptime(60), '1m')
  assert.equal(formatUptime(3599), '59m')
  assert.equal(formatUptime(3600), '1h 0m')
  assert.equal(formatUptime(7500), '2h 5m')
  assert.equal(formatUptime(86400), '1d 0h')
  assert.equal(formatUptime(200000), '2d 7h')
})

test('status when running', () => {
  const text = formatStatus({
    version: '0.2.0', running: true, url: 'http://127.0.0.1:4747', pid: 4321, uptimeSec: 7500,
    dataDir: '~/.missioncontrol', logFile: '~/.missioncontrol/logs/gateway.log',
  })
  assert.equal(text, [
    'Mission Control 0.2.0',
    'Status:   running (pid 4321, up 2h 5m)',
    'Address:  http://127.0.0.1:4747',
    'Data:     ~/.missioncontrol',
    'Log:      ~/.missioncontrol/logs/gateway.log',
  ].join('\n'))
})

test('status when stopped says how to start it', () => {
  const text = formatStatus({
    version: '0.2.0', running: false, url: 'http://127.0.0.1:4747',
    dataDir: '~/.missioncontrol', logFile: '~/.missioncontrol/logs/gateway.log',
  })
  assert.equal(text.split('\n')[1], 'Status:   not running (start it with: mc start)')
  assert.equal(text.split('\n').length, 5)
})

test('doctor lists every check, with the fix under each problem, then a summary', () => {
  const text = formatDoctor([
    { name: 'Node.js', status: 'ok', detail: 'v24.22.0' },
    { name: 'Gateway', status: 'fail', detail: 'not running', fix: 'mc start' },
    { name: 'Model server', status: 'warn', detail: 'no answer from http://127.0.0.1:1234/v1', fix: 'Start LM Studio and load a model' },
    { name: 'Data folder', status: 'info', detail: 'protected by your Windows user folder' },
  ])
  assert.equal(text, [
    '[ok]   Node.js: v24.22.0',
    '[FAIL] Gateway: not running',
    '       fix: mc start',
    '[warn] Model server: no answer from http://127.0.0.1:1234/v1',
    '       fix: Start LM Studio and load a model',
    '[info] Data folder: protected by your Windows user folder',
    '',
    '1 problem, 1 warning.',
  ].join('\n'))
})

test('doctor summary wording', () => {
  assert.match(formatDoctor([{ name: 'A', status: 'ok', detail: 'fine' }]), /\n\nAll checks passed\.$/)
  assert.match(formatDoctor([{ name: 'A', status: 'info', detail: 'x' }]), /\n\nAll checks passed\.$/)
  const many = formatDoctor([
    { name: 'A', status: 'fail', detail: 'x' }, { name: 'B', status: 'fail', detail: 'y' },
    { name: 'C', status: 'warn', detail: 'z' }, { name: 'D', status: 'warn', detail: 'w' },
  ])
  assert.match(many, /\n\n2 problems, 2 warnings\.$/)
  assert.match(formatDoctor([{ name: 'A', status: 'warn', detail: 'x' }]), /\n\n0 problems, 1 warning\.$/)
})

test('help names every command and the version', () => {
  const text = helpText('0.2.0')
  assert.equal(text.split('\n')[0], 'Mission Control 0.2.0')
  for (const command of ['start', 'stop', 'status', 'open', 'logs', 'doctor', 'shortcuts', 'uninstall', 'version', 'help']) {
    assert.match(text, new RegExp(`^  mc ${command}\\b`, 'm'), command)
  }
  assert.doesNotMatch(text, /—/, 'no em-dashes in user-facing text')
})
