// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runWorker, type WorkerRunConfig } from '../src/worker-loop.js'
import { AgentRegistry } from '../src/agents/registry.js'
import type { ProviderAdapter, CompletionRequest, StreamChunk } from '../src/providers/types.js'
import type { RegisteredTool } from '../src/tools/types.js'

const SPECS_DIR = path.join(__dirname, '..', 'src', 'agents', 'specs')

// A pretend model that plays the given turns in order, one per call. Each turn is some text and optionally tool calls.
function scripted(turns: Array<{ text?: string; tools?: Array<{ name: string; args: Record<string, unknown> }> }>): { provider: ProviderAdapter; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  let call = 0
  const provider: ProviderAdapter = {
    name: 'scripted',
    async *complete(request: CompletionRequest): AsyncGenerator<StreamChunk> {
      requests.push({ ...request, messages: [...request.messages] })
      const turn = turns[Math.min(call++, turns.length - 1)]!
      if (turn.text) yield { type: 'text_delta', delta: turn.text }
      for (const [i, t] of (turn.tools ?? []).entries()) {
        yield { type: 'tool_call', toolCall: { id: `t${call}-${i}`, name: t.name, arguments: t.args } }
      }
      yield { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
    },
  }
  return { provider, requests }
}

function config(provider: ProviderAdapter, written: string[]): { cfg: WorkerRunConfig; errors: string[] } {
  const errors: string[] = []
  const artifactWrite: RegisteredTool = {
    schema: { name: 'artifact_write', description: 'save', parameters: { type: 'object', properties: {} } },
    execute: async (args: Record<string, unknown>) => {
      written.push(String(args['content']))
      return { correlationId: 'c', toolName: 'artifact_write', status: 'ok' as const, output: JSON.stringify({ id: `art-${written.length}` }), durationMs: 1 }
    },
  } as unknown as RegisteredTool
  const cfg = {
    role: 'worker-researcher', task: 'Research X', allowedTools: ['artifact_write'], correlationId: 'corr-1',
    db: {}, registry: AgentRegistry.loadFromDirectory(SPECS_DIR), provider, model: 'm', tools: new Map([['artifact_write', artifactWrite]]),
    monitorBuffer: { enqueue: (e: { code?: string }) => { if (e.code) errors.push(e.code) } }, broadcast: () => {},
  } as unknown as WorkerRunConfig
  return { cfg, errors }
}

test('a worker that stops with its report as plain text is reminded once, then saves it', async () => {
  const written: string[] = []
  const { provider, requests } = scripted([
    { text: 'Here is my whole report as plain text.' },
    { tools: [{ name: 'artifact_write', args: { type: 'report', title: 'R', content: 'Here is my whole report as plain text.' } }] },
    { text: 'done' },
  ])
  const { cfg, errors } = config(provider, written)
  const result = await runWorker(cfg)
  assert.equal(result.status, 'ok')
  assert.equal(result.artifactId, 'art-1')
  assert.deepEqual(written, ['Here is my whole report as plain text.'])
  assert.deepEqual(errors, ['WORKER_ARTIFACT_REMINDER'])
  const reminder = requests[1]!.messages.at(-1)!
  assert.equal(reminder.role, 'user')
  assert.match(String(reminder.content), /artifact_write/)
  assert.equal(requests[1]!.messages.at(-2)!.content, 'Here is my whole report as plain text.', 'its own text stays in the conversation')
})

test('a worker that ignores the reminder still fails with WORKER_NO_ARTIFACT (only one reminder)', async () => {
  const written: string[] = []
  const { provider, requests } = scripted([{ text: 'plain text' }, { text: 'still just text' }])
  const { cfg, errors } = config(provider, written)
  const result = await runWorker(cfg)
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /WORKER_NO_ARTIFACT/)
  assert.equal(requests.length, 2)
  assert.deepEqual(errors, ['WORKER_ARTIFACT_REMINDER', 'WORKER_NO_ARTIFACT'])
  assert.equal(written.length, 0)
})

test('a worker that already saved its artifact is not reminded', async () => {
  const written: string[] = []
  const { provider, requests } = scripted([
    { tools: [{ name: 'artifact_write', args: { type: 'report', title: 'R', content: 'ok' } }] },
    { text: 'done' },
  ])
  const { cfg, errors } = config(provider, written)
  const result = await runWorker(cfg)
  assert.equal(result.status, 'ok')
  assert.equal(requests.length, 2)
  assert.deepEqual(errors, [])
})
