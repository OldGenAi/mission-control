// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/store/db.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { makePipelineRunner } from '../src/pipeline/runner.js'
import type { PipelineDefinition } from '../src/pipeline/types.js'
import type { ProviderAdapter, StreamChunk } from '../src/providers/types.js'

const SPECS_DIR = path.join(__dirname, '..', 'src', 'agents', 'specs')

/** A runner whose every llm step reports 60 tokens used. */
function setup() {
  const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'mc-budget-')), 'db.sqlite'))
  const provider: ProviderAdapter = {
    name: 'scripted',
    async *complete(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', delta: 'done' }
      yield { type: 'done', usage: { inputTokens: 50, outputTokens: 10 } }
    },
  }
  const runner = makePipelineRunner({
    db, monitorBuffer: { enqueue: () => {} } as never, agentId: 'test', correlationId: 'c', provider, model: 'm',
    tools: new Map(), registry: AgentRegistry.loadFromDirectory(SPECS_DIR), broadcast: () => {},
  })
  return { db, runner }
}

function pipeline(steps: number, maxTokens: number): PipelineDefinition {
  return {
    id: 'p', name: 'P', version: '1',
    budget: { maxTokens, maxCostUsd: 1, timeoutSeconds: 60, onExceed: 'abort' },
    steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}`, type: 'llm' as const, userPrompt: 'go', requiresEvidence: false })),
  }
}

test('a run that goes over budget on its last step keeps its finished result and says so', async () => {
  const { db, runner } = setup()
  try {
    const run = await runner.run(pipeline(2, 100), {})
    assert.equal(run.status, 'completed')
    assert.equal(run.tokensUsed, 120)
    assert.match(run.error ?? '', /^finished over budget: 120 tokens used \/ 100 limit$/)
  } finally {
    db.close()
  }
})

test('a run that goes over budget before its last step is still aborted', async () => {
  const { db, runner } = setup()
  try {
    await assert.rejects(runner.run(pipeline(3, 100), {}), /budget exceeded: 120 tokens used/)
    const row = db.prepare(`SELECT status FROM pipeline_runs`).get() as { status: string }
    assert.equal(row.status, 'aborted')
  } finally {
    db.close()
  }
})
