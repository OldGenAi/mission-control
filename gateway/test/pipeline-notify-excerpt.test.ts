// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/store/db.js'
import { PipelineNotifier, excerpt, type NotifierConfig } from '../src/notify/pipeline-notify.js'
import type { PipelineRun } from '../src/pipeline/types.js'

function run(id: string, status: PipelineRun['status'], extra: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id, name: 'Research Task', pipelineId: 'research_task', status, revision: 1, currentStepId: null, context: {}, approvalId: null, resumeToken: null,
    error: null, tokensUsed: 1234, costUsdUsed: 0, createdAt: 1_000, updatedAt: 61_000, pausedMs: 0, ...extra,
  }
}

function setup() {
  const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'mc-notify-')), 'db.sqlite'))
  const add = db.prepare(`INSERT INTO artifacts (id, type, title, content, agent_id, pipeline_run_id, created_at) VALUES (?, ?, ?, ?, 'worker', ?, ?)`)
  const notifier = new PipelineNotifier({ db } as unknown as NotifierConfig) as unknown as { composeMessage(runs: PipelineRun[]): string }
  return { db, add, compose: (runs: PipelineRun[]) => notifier.composeMessage(runs) }
}

test('excerpt keeps short text whole and cuts long text at a line end, saying how much was left out', () => {
  assert.equal(excerpt('short', 100), 'short')
  const text = Array.from({ length: 40 }, (_, i) => `line number ${i} of the report`).join('\n')
  const cut = excerpt(text, 200)
  assert.ok(cut.length < 300)
  assert.match(cut, /\[\.\.\. \d+ more characters not shown\]$/)
  assert.ok(!/line number \d+ of the repor\n/.test(cut), 'cut on a whole line')
})

test('a completed run shows Dave the start of its biggest report, marked untrusted, and asks for the main findings', () => {
  const { db, add, compose } = setup()
  try {
    add.run('a1', 'report', 'Summary', 'Short summary with no news.', 'r1', 10)
    add.run('a2', 'report', 'AI News Roundup', `# News\n- DeepSeek shipped V4.1 on October 17.\n${'filler line\n'.repeat(1000)}`, 'r1', 20)
    const message = compose([run('r1', 'completed')])
    assert.match(message, /UNTRUSTED/)
    assert.match(message, /DeepSeek shipped V4\.1 on October 17\./)
    assert.ok(message.indexOf('--- [report] AI News Roundup') < message.indexOf('--- [report] Summary'), 'the biggest report comes first')
    assert.match(message, /characters not shown/)
    assert.match(message, /three to five most important findings/)
    assert.ok(message.length < 9000, `bounded: ${message.length}`)
    assert.match(message, /do NOT call pipeline_status/)
  } finally {
    db.close()
  }
})

test('a failed run, or one with no reports, gets the old short message and no report text', () => {
  const { db, add, compose } = setup()
  try {
    add.run('a3', 'report', 'Half report', 'Some text that must not be shown for a failed run.', 'r2', 10)
    const failed = compose([run('r2', 'failed', { error: 'boom' })])
    assert.ok(!failed.includes('Some text that must not be shown'))
    assert.ok(!/UNTRUSTED/.test(failed))
    assert.match(failed, /2-3 short sentences/)
    const empty = compose([run('r3', 'completed')])
    assert.match(empty, /artifacts: none/)
    assert.match(empty, /2-3 short sentences/)
  } finally {
    db.close()
  }
})

test('deleted reports are never shown', () => {
  const { db, add, compose } = setup()
  try {
    add.run('a4', 'report', 'Old report', 'Deleted content must stay out.', 'r4', 10)
    db.prepare(`UPDATE artifacts SET deleted_at = 5 WHERE id = 'a4'`).run()
    assert.ok(!compose([run('r4', 'completed')]).includes('Deleted content must stay out.'))
  } finally {
    db.close()
  }
})

test('several runs are summarised together, each with its own excerpt', () => {
  const { db, add, compose } = setup()
  try {
    add.run('a5', 'report', 'First', 'Finding about alpha.', 'r5', 10)
    add.run('a6', 'report', 'Second', 'Finding about beta.', 'r6', 11)
    const message = compose([run('r5', 'completed'), run('r6', 'completed')])
    assert.match(message, /2 pipelines/)
    assert.match(message, /alpha/)
    assert.match(message, /beta/)
  } finally {
    db.close()
  }
})
