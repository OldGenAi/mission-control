// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ThinkTagSplitter, withoutUnopenedThinking } from '../src/providers/think-tags.js'
import { LocalProvider } from '../src/providers/local.js'
import { openDatabase } from '../src/store/db.js'
import { AgentLoop } from '../src/loop.js'
import { AgentRegistry } from '../src/agents/registry.js'
import type { ProviderAdapter, CompletionRequest, StreamChunk } from '../src/providers/types.js'
import type { RegisteredTool } from '../src/tools/types.js'

// What LM Studio really sent for Qwen 3.8 27B with thinking on (2026-10-24), as one string.
const LM_STUDIO_REPLY = '<think>We need answer user\'s simple math. Compute 17*23 = 340+51=391.\n</think>\n\n17 times 23 is 391.'

function split(pieces: string[]): { thinking: string; reply: string } {
  const splitter = new ThinkTagSplitter()
  const chunks = [...pieces.flatMap((p) => splitter.push(p)), ...splitter.flush()]
  return {
    thinking: chunks.filter((c) => c.type === 'thinking_delta').map((c) => c.delta).join(''),
    reply: chunks.filter((c) => c.type === 'text_delta').map((c) => c.delta).join(''),
  }
}

test('an inline <think> block becomes thinking and the reply is left clean', () => {
  assert.deepEqual(split([LM_STUDIO_REPLY]), {
    thinking: 'We need answer user\'s simple math. Compute 17*23 = 340+51=391.\n',
    reply: '17 times 23 is 391.',
  })
})

test('tags cut anywhere by the stream are still recognised', () => {
  for (let cut = 1; cut < LM_STUDIO_REPLY.length; cut++) {
    const result = split([LM_STUDIO_REPLY.slice(0, cut), LM_STUDIO_REPLY.slice(cut)])
    assert.equal(result.reply, '17 times 23 is 391.', `cut at ${cut}`)
    assert.ok(!result.thinking.includes('<') && !result.reply.includes('think>'), `cut at ${cut}`)
  }
  assert.equal(split([...LM_STUDIO_REPLY]).reply, '17 times 23 is 391.', 'one character at a time')
})

test('a reply without thinking passes through unchanged', () => {
  assert.deepEqual(split(['  Hello', ' there.']), { thinking: '', reply: '  Hello there.' })
})

test('a reply that mentions the tag later on is not treated as thinking', () => {
  const text = 'Qwen wraps its reasoning in <think> and </think> tags.'
  assert.deepEqual(split([text]), { thinking: '', reply: text })
})

test('an unclosed thinking block (token limit hit mid-thought) never becomes the reply', () => {
  assert.deepEqual(split(['<think>Still working it out </th']), { thinking: 'Still working it out </th', reply: '' })
})

test('a reply that is only whitespace or a lone fragment of the tag is kept as text', () => {
  assert.deepEqual(split(['  \n']), { thinking: '', reply: '' })
  assert.deepEqual(split(['<thi']), { thinking: '', reply: '<thi' })
})

test('a finished reply whose template opened the thinking itself loses everything up to the closing tag', () => {
  assert.equal(withoutUnopenedThinking('Okay, 17*23 = 391.\n</think>\n\n17 times 23 is 391.'), '17 times 23 is 391.')
  assert.equal(withoutUnopenedThinking('17 times 23 is 391.'), '17 times 23 is 391.')
  const explained = 'Qwen wraps its reasoning in <think> and </think> tags.'
  assert.equal(withoutUnopenedThinking(explained), explained)
})

// A stand-in for LM Studio: streams `deltas` and records the request body it was sent.
async function withFakeServer(deltas: object[], run: (baseUrl: string, bodies: Record<string, unknown>[]) => Promise<void>): Promise<void> {
  const bodies: Record<string, unknown>[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (part: Buffer) => { raw += part.toString('utf8') })
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const delta of deltas) res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function collect(provider: LocalProvider, extra: Partial<CompletionRequest> = {}): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  const request: CompletionRequest = { model: 'm', messages: [{ role: 'user', content: 'what is 17 times 23?' }], correlationId: 'think-test', ...extra }
  for await (const chunk of provider.complete(request)) out.push(chunk)
  return out
}

const textOf = (chunks: StreamChunk[], type: 'text_delta' | 'thinking_delta') =>
  chunks.flatMap((c) => (c.type === type ? [c.delta] : [])).join('')

test('the local provider keeps inline thinking out of the reply text', async () => {
  const pieces = ['<think>Compute', ' 17*23 = 391.\n</th', 'ink>\n\n17 times', ' 23 is 391.']
  await withFakeServer(pieces.map((content) => ({ content })), async (baseUrl) => {
    const chunks = await collect(new LocalProvider({ baseUrl }))
    assert.equal(textOf(chunks, 'text_delta'), '17 times 23 is 391.')
    assert.equal(textOf(chunks, 'thinking_delta'), 'Compute 17*23 = 391.\n')
    assert.equal(chunks.at(-1)?.type, 'done')
  })
})

test('thinking sent in a separate field (LM Studio reasoning_content, Ollama reasoning) is thinking, not reply', async () => {
  const deltas = [{ reasoning_content: 'Compute ' }, { reasoning: '17*23.' }, { content: '391.' }]
  await withFakeServer(deltas, async (baseUrl) => {
    const chunks = await collect(new LocalProvider({ baseUrl }))
    assert.equal(textOf(chunks, 'thinking_delta'), 'Compute 17*23.')
    assert.equal(textOf(chunks, 'text_delta'), '391.')
  })
})

test('no thinking level is sent to the local server: some refuse it for models that cannot think', async () => {
  await withFakeServer([{ content: 'ok' }], async (baseUrl, bodies) => {
    await collect(new LocalProvider({ baseUrl }), { reasoning: { effort: 'high' } })
    assert.ok(!('reasoning_effort' in (bodies[0] ?? {})))
  })
})

// Runs one chat turn against a scripted provider that answers each model round with the next list of chunks.
async function runTurn(rounds: StreamChunk[][]) {
  const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'mc-thinking-')), 'db.sqlite'))
  db.prepare(`INSERT INTO sessions (id, agent_id, title, created_at, updated_at) VALUES ('s1', 'tier1_agent', 't', 1, 1)`).run()
  let round = 0
  const provider: ProviderAdapter = {
    name: 'scripted',
    async *complete(): AsyncGenerator<StreamChunk> {
      yield* rounds[round++] ?? []
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
  const fileList: RegisteredTool = {
    schema: { name: 'file_list', description: 'list', parameters: { type: 'object', properties: {} } },
    execute: async () => ({ correlationId: 'c', toolName: 'file_list', status: 'ok' as const, output: '[]', durationMs: 1 }),
  } as unknown as RegisteredTool
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []
  const loop = new AgentLoop({
    agentId: 'tier1_agent', provider, model: 'm', registry: AgentRegistry.loadFromDirectory(path.join(__dirname, '..', 'src', 'agents', 'specs')), db,
    monitorBuffer: { enqueue: () => {} } as never, tools: new Map([['file_list', fileList]]), execEnabled: false,
    broadcast: (_clientId, event, payload) => { events.push({ event, payload }) },
  })
  try {
    await loop.run({ message: 'what is 17 times 23?', sessionId: 's1', clientId: '' })
    const saved = db.prepare(`SELECT content FROM messages WHERE session_id = 's1' AND role = 'assistant'`).all() as Array<{ content: string }>
    return {
      thinking: events.filter((e) => e.event === 'chat.thinking').map((e) => e.payload),
      finalText: events.find((e) => e.event === 'chat.final')?.payload['text'],
      saved: saved.map((row) => row.content),
    }
  } finally {
    db.close()
  }
}

test('the agent loop shows thinking live but never saves it as the reply', async () => {
  const turn = await runTurn([[{ type: 'thinking_delta', delta: 'Compute 17*23.' }, { type: 'text_delta', delta: '391.' }]])
  assert.deepEqual(turn.thinking.map((p) => [p['delta'], p['sessionId']]), [['Compute 17*23.', 's1']])
  assert.equal(turn.finalText, '391.')
  assert.deepEqual(turn.saved, ['391.'])
})

test('thinking from a later tool round starts a new paragraph in the live box', async () => {
  const turn = await runTurn([
    [{ type: 'thinking_delta', delta: 'List the files.' }, { type: 'tool_call', toolCall: { id: 'c1', name: 'file_list', arguments: {} } }],
    [{ type: 'thinking_delta', delta: 'None there.' }, { type: 'text_delta', delta: 'The folder is empty.' }],
  ])
  assert.deepEqual(turn.thinking.map((p) => p['delta']), ['List the files.', '\n\nNone there.'])
  assert.equal(turn.finalText, 'The folder is empty.')
})

test('a model that ran out of room mid-thought gets an explanation, not a blank reply', async () => {
  const turn = await runTurn([[{ type: 'thinking_delta', delta: 'Still working it out' }]])
  assert.match(String(turn.finalText), /ran out of room while thinking/)
  assert.deepEqual(turn.saved, [turn.finalText])
})

test('thinking that arrived without an opening tag is cleaned from the saved reply', async () => {
  const turn = await runTurn([[{ type: 'text_delta', delta: 'Okay, 17*23 = 391.\n</think>\n\n' }, { type: 'text_delta', delta: '17 times 23 is 391.' }]])
  assert.equal(turn.finalText, '17 times 23 is 391.')
  assert.deepEqual(turn.saved, ['17 times 23 is 391.'])
})
