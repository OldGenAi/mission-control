// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addClient, removeClient, mirrorToOtherClients } from '../src/broadcast.js'
import type { ConnectedClient } from '../src/types.js'

function fakeClient(id: string, authed = true): { client: ConnectedClient; sent: Array<{ event: string; payload: Record<string, unknown> }> } {
  const sent: Array<{ event: string; payload: Record<string, unknown> }> = []
  const ws = { readyState: 1, send: (data: string) => { const m = JSON.parse(data); sent.push({ event: m.event, payload: m.payload }) } }
  return { client: { id, ws: ws as unknown as ConnectedClient['ws'], authed, connectedAt: 0 }, sent }
}

function withClients(run: (a: ReturnType<typeof fakeClient>, b: ReturnType<typeof fakeClient>, c: ReturnType<typeof fakeClient>) => void): void {
  const a = fakeClient('sender'), b = fakeClient('page'), c = fakeClient('not-logged-in', false)
  for (const x of [a, b, c]) addClient(x.client)
  try { run(a, b, c) } finally { for (const x of [a, b, c]) removeClient(x.client.id) }
}

test('a chat turn started by one client is mirrored to the other signed-in windows, not back to the sender', () => {
  withClients((sender, page, stranger) => {
    mirrorToOtherClients('sender', 'chat.delta', { delta: 'hi', sessionId: 's1', correlationId: 'c1' })
    assert.deepEqual(page.sent, [{ event: 'chat.delta', payload: { delta: 'hi', sessionId: 's1', correlationId: 'c1' } }])
    assert.equal(sender.sent.length, 0)
    assert.equal(stranger.sent.length, 0, 'a client that has not logged in gets nothing')
  })
})

test('the events a chat page needs are mirrored: delta, final and status', () => {
  withClients((_sender, page) => {
    for (const event of ['chat.delta', 'chat.final', 'agent.status'] as const) {
      mirrorToOtherClients('sender', event, { sessionId: 's1' })
    }
    assert.deepEqual(page.sent.map((m) => m.event), ['chat.delta', 'chat.final', 'agent.status'])
  })
})

test('other events and events that do not say which session they belong to stay with the sender', () => {
  withClients((_sender, page) => {
    mirrorToOtherClients('sender', 'session.tool', { sessionId: 's1' })       // tool details: not for other windows
    mirrorToOtherClients('sender', 'monitor.tick', { sessionId: 's1' })
    mirrorToOtherClients('sender', 'chat.delta', { delta: 'no session' })     // nothing says where it belongs
    assert.equal(page.sent.length, 0)
  })
})
