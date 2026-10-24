// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/store/db.js'
import { AgentLoop } from '../src/loop.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { isPipelineName } from '../src/pipeline/loader.js'
import { makeDoctorStatusTool } from '../src/tools/doctor.js'
import type { DoctorEngine } from '../src/doctor/engine.js'
import type { ProviderAdapter, CompletionRequest, StreamChunk } from '../src/providers/types.js'
import type { RegisteredTool, ToolResult } from '../src/tools/types.js'

const SPECS_DIR = path.join(__dirname, '..', 'src', 'agents', 'specs')

interface Round {
  /** Tool to call this round; omitted = answer with `text`. */
  call?: { name: string; arguments: Record<string, unknown> }
  text?: string
}

/** A provider that plays back `rounds` in order and records every request it was sent. */
function setup(rounds: Round[], toolOutput: (args: Record<string, unknown>) => Pick<ToolResult, 'status' | 'output' | 'error'>, maxIterations = 4) {
  const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'mc-wrapup-')), 'db.sqlite'))
  db.prepare(`INSERT INTO sessions (id, agent_id, title, created_at, updated_at) VALUES ('s1', 'tier1_agent', 't', 1, 1)`).run()
  const requests: CompletionRequest[] = []
  let next = 0
  const provider: ProviderAdapter = {
    name: 'scripted',
    async *complete(request: CompletionRequest): AsyncGenerator<StreamChunk> {
      requests.push({ ...request, messages: [...request.messages] })
      const round = rounds[Math.min(next++, rounds.length - 1)]!
      if (round.call) yield { type: 'tool_call', toolCall: { id: `c${next}`, name: round.call.name, arguments: round.call.arguments } }
      if (round.text) yield { type: 'text_delta', delta: round.text }
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
  let executions = 0
  const memoryGet: RegisteredTool = {
    schema: { name: 'memory_get', description: 'get', parameters: { type: 'object', properties: {} } },
    execute: async (args, ctx) => {
      executions++
      return { correlationId: ctx.correlationId, toolName: 'memory_get', durationMs: 0, ...toolOutput(args) }
    },
  }
  const finals: Array<Record<string, unknown>> = []
  const loop = new AgentLoop({
    agentId: 'tier1_agent', provider, model: 'm', registry: AgentRegistry.loadFromDirectory(SPECS_DIR), db,
    monitorBuffer: { enqueue: () => {} } as never, tools: new Map([['memory_get', memoryGet]]), execEnabled: false, maxIterations,
    broadcast: (_client, event, payload) => { if (event === 'chat.final') finals.push(payload) },
  })
  const stored = () => db.prepare(`SELECT role, content FROM messages WHERE session_id = 's1' ORDER BY created_at, rowid`).all() as Array<{ role: string; content: string }>
  return { db, loop, requests, finals, stored, executions: () => executions }
}

const lastMessage = (request: CompletionRequest) => request.messages[request.messages.length - 1]!

test('the last allowed step is offered no tools and the model answers with what it found', async () => {
  let n = 0
  const call = { call: { name: 'memory_get', arguments: {} } }
  const t = setup([call, call, { text: 'Here is what I found.' }], () => ({ status: 'ok', output: `{"entry":${n++}}` }), 3)
  try {
    await t.loop.run({ message: 'look around', sessionId: 's1', clientId: '' })
    assert.deepEqual(t.requests.map((r) => r.tools?.map((d) => d.name)), [['memory_get'], ['memory_get'], undefined])
    assert.match(String(lastMessage(t.requests[2]!).content), /used all your tool steps/)
    assert.equal(t.finals.length, 1)
    assert.equal(t.finals[0]!['wrapUp'], 'steps')
    assert.ok(!t.stored().some((m) => m.content.includes('Tools are off now')), 'the wrap-up note is never stored')
  } finally {
    t.db.close()
  }
})

test('a wrap-up with no answer falls back to the old notice instead of a blank reply', async () => {
  const t = setup([{ call: { name: 'memory_get', arguments: { key: 'x' } } }], (args) => ({ status: 'ok', output: JSON.stringify(args) }), 1)
  try {
    await t.loop.run({ message: 'go', sessionId: 's1', clientId: '' })
    assert.equal(t.requests[0]!.tools, undefined)
    assert.equal(t.finals[0]!['text'], '[Loop limit reached: the agent stopped after the maximum number of steps.]')
    assert.equal(t.executions(), 0, 'a tool call made in the wrap-up round is dropped, not run')
  } finally {
    t.db.close()
  }
})

test('a call repeated with the same result is answered with a short error instead of the same result again', async () => {
  const t = setup([
    { call: { name: 'memory_get', arguments: { key: '2026-10-24' } } },
    { call: { name: 'memory_get', arguments: { key: '2026-10-24' } } },
    { text: 'Nothing saved for today.' },
  ], () => ({ status: 'ok', output: '{"entry":null}' }), 6)
  try {
    await t.loop.run({ message: 'what did we do today', sessionId: 's1', clientId: '' })
    const toolReplies = t.stored().filter((m) => m.role === 'tool').map((m) => m.content)
    assert.equal(toolReplies[0], '{"entry":null}')
    assert.match(toolReplies[1]!, /Same tool, same arguments and same result/)
    assert.equal(t.finals[0]!['text'], 'Nothing saved for today.')
  } finally {
    t.db.close()
  }
})

test('the same call is passed through again when its result changed', async () => {
  let n = 0
  const t = setup([
    { call: { name: 'memory_get', arguments: { key: 'k' } } },
    { call: { name: 'memory_get', arguments: { key: 'k' } } },
    { text: 'done' },
  ], () => ({ status: 'ok', output: `{"entry":${n++}}` }), 6)
  try {
    await t.loop.run({ message: 'go', sessionId: 's1', clientId: '' })
    assert.deepEqual(t.stored().filter((m) => m.role === 'tool').map((m) => m.content), ['{"entry":0}', '{"entry":1}'])
  } finally {
    t.db.close()
  }
})

test('repeated tool failures wrap the turn up with an answer instead of a bare stop', async () => {
  let n = 0
  const t = setup([
    { call: { name: 'memory_get', arguments: { key: 'a' } } },
    { call: { name: 'memory_get', arguments: { key: 'b' } } },
    { call: { name: 'memory_get', arguments: { key: 'c' } } },
    { text: 'The memory store kept failing, so I could not check.' },
  ], () => ({ status: 'error', output: '', error: `store unavailable ${n++}` }), 10)
  try {
    await t.loop.run({ message: 'check memory', sessionId: 's1', clientId: '' })
    assert.equal(t.requests.length, 4)
    assert.equal(t.requests[3]!.tools, undefined)
    const note = String(lastMessage(t.requests[3]!).content)
    assert.match(note, /kept failing/)
    assert.ok(!note.includes('store unavailable'), 'error text from a tool never goes into the note sent with the person\'s role')
    assert.equal(t.finals[0]!['wrapUp'], 'failures')
    assert.equal(t.finals[0]!['text'], 'The memory store kept failing, so I could not check.')
  } finally {
    t.db.close()
  }
})

test('pipeline names that are paths are refused', () => {
  for (const ok of ['research_task', 'code-review', 'My Pipeline v2']) assert.ok(isPipelineName(ok), ok)
  for (const bad of ['', '..', '../../mission-control/evil', 'sub/name', 'sub\\name', '.hidden', 'a\0b', 'x'.repeat(101)]) {
    assert.ok(!isPipelineName(bad), JSON.stringify(bad))
  }
})

test('doctor_status reports issues and passed checks, read only', async () => {
  const engine = {
    status: () => ({
      checkedAt: Date.UTC(2026, 9, 24, 22, 0),
      overall: 'warn',
      issues: [{ id: 'lmstudio', area: 'models', title: 'LM Studio', status: 'warn', summary: 'Slow to answer', steps: ['Open LM Studio'], fixesLeft: 3 }],
      ignored: [],
      passed: [{ id: 'db', area: 'data', title: 'Database', status: 'ok', summary: 'Healthy' }],
    }),
  } as unknown as DoctorEngine
  const result = await makeDoctorStatusTool(engine).execute({}, { correlationId: 'c', agentId: 'tier1_agent' })
  assert.equal(result.status, 'ok')
  assert.deepEqual(JSON.parse(result.output), {
    overall: 'warn',
    checkedAt: '2026-10-24T22:00:00.000Z',
    issues: [{ title: 'LM Studio', status: 'warn', summary: 'Slow to answer', steps: ['Open LM Studio'] }],
    ignoredByPerson: [],
    passed: ['Database: Healthy'],
  })
})
