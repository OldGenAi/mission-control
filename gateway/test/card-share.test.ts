// Run with: npm test
// Sharing the graphics card between the local model server and videos (src/providers/card-share.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardShare, estimatedBytes, type CardShareEvent, type LoadedModel, type ModelServer } from '../src/providers/card-share.js'

const QWEN: LoadedModel = { model: 'qwen/qwen3.5-9b', instanceId: 'qwen/qwen3.5-9b', config: { context_length: 32768, flash_attention: true } }

// A stand-in LM Studio: what is loaded, and every load and unload asked of it.
function fakeServer(loaded: LoadedModel[] = [], opts: { loadWorks?: boolean } = {}) {
  const state = { loaded: [...loaded], loads: [] as LoadedModel[], unloads: [] as string[] }
  const server: ModelServer = {
    async listLoaded() { return state.loaded.map((m) => ({ ...m, config: { ...m.config } })) },
    async unload(instanceId) {
      state.unloads.push(instanceId)
      state.loaded = state.loaded.filter((m) => m.instanceId !== instanceId)
      return true
    },
    async load(m) {
      state.loads.push(m)
      if (opts.loadWorks === false) return false
      state.loaded.push(m)
      return true
    },
  }
  return { server, state }
}

function setup(server: ModelServer | null, notePath = join(mkdtempSync(join(tmpdir(), 'mc-card-')), 'card-share.json')) {
  const events: CardShareEvent[] = []
  let frees = 0
  const share = new CardShare({
    server: () => server,
    freeVideoMemory: async () => { frees++ },
    notePath,
    emit: (e) => events.push(e),
    pollMs: 10,
  })
  return { share, events, frees: () => frees, notePath }
}

async function waitFor(check: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
  return check()
}

const never = () => false
const noStage = () => {}

test('nothing loaded when the video starts: nothing is unloaded, and nothing is ever loaded afterwards', async () => {
  const { server, state } = fakeServer([])
  const { share } = setup(server)
  share.setVideoBusy(true)
  assert.equal(await share.makeRoom(never, noStage), 'nothing')
  share.setVideoBusy(false)
  share.restoreNow()
  const release = await share.enter()
  release()
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(state.unloads, [])
  assert.deepEqual(state.loads, [], 'opening Chat or chatting loads nothing that was not taken away')
})

test('a loaded model is unloaded for the video and put back exactly as it was, but only when it is needed', async () => {
  const { server, state } = fakeServer([QWEN])
  const { share, frees, notePath } = setup(server)
  share.setVideoBusy(true)
  assert.equal(await share.makeRoom(never, noStage), 'unloaded')
  assert.deepEqual(state.unloads, [QWEN.instanceId])
  assert.ok(existsSync(notePath), 'the note of what was taken away is saved')

  share.setVideoBusy(false)
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(state.loads, [], 'no reload on a timer or when the video ends')

  share.restoreNow()   // the Chat page was opened
  assert.ok(await waitFor(() => state.loads.length === 1))
  assert.deepEqual(state.loads[0], QWEN, 'the same model with the same settings')
  assert.equal(frees(), 1, 'ComfyUI was asked for its memory back first')
  assert.ok(await waitFor(() => share.state().state === 'free'))
  share.restoreNow()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(state.loads.length, 1, 'once it is back, opening Chat again does nothing')
})

test('a chat that arrives after the video puts the model back first, then runs', async () => {
  const { server, state } = fakeServer([QWEN])
  const { share } = setup(server)
  share.setVideoBusy(true)
  await share.makeRoom(never, noStage)
  share.setVideoBusy(false)
  const release = await share.enter()
  assert.equal(state.loads.length, 1, 'loaded before the call was let through')
  release()
})

test('a chat that arrives during the video waits until the videos are done', async () => {
  const { server, state } = fakeServer([QWEN])
  const { share, events } = setup(server)
  share.setVideoBusy(true)
  await share.makeRoom(never, noStage)
  let entered = false
  const pending = share.enter().then((release) => { entered = true; release() })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(entered, false, 'it waits while the card is making videos')
  assert.ok(events.some((e) => e.state === 'held'), 'the page is told the card is in use')
  share.setVideoBusy(false)
  await pending
  assert.equal(entered, true)
  assert.equal(state.loads.length, 1)
})

test('a chat already running when a video starts is allowed to finish before the model is unloaded', async () => {
  const { server, state } = fakeServer([QWEN])
  const { share } = setup(server)
  const release = await share.enter()
  const stages: string[] = []
  share.setVideoBusy(true)
  const room = share.makeRoom(never, (s) => stages.push(s))
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(state.unloads, [], 'not unloaded while the reply is still coming')
  assert.ok(stages.includes('Waiting for a chat to finish'))

  // A new chat while the video waits for the first one also waits, so the video is not starved.
  let lateEntered = false
  const late = share.enter().then((r) => { lateEntered = true; r() })
  release()
  assert.equal(await room, 'unloaded')
  assert.deepEqual(state.unloads, [QWEN.instanceId])
  assert.equal(lateEntered, false, 'the late chat is still waiting for the video')
  share.setVideoBusy(false)
  await late
})

test('three videos in a row: the model is unloaded once and put back once', async () => {
  const { server, state } = fakeServer([QWEN])
  const { share } = setup(server)
  share.setVideoBusy(true)
  for (let i = 0; i < 3; i++) await share.makeRoom(never, noStage)
  share.setVideoBusy(false)
  share.restoreNow()
  assert.ok(await waitFor(() => state.loads.length === 1))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(state.unloads.length, 1)
  assert.equal(state.loads.length, 1)
})

test('a model that cannot be put back is named, and chats are not held up for ever', async () => {
  const { server } = fakeServer([QWEN], { loadWorks: false })
  const { share, events } = setup(server)
  share.setVideoBusy(true)
  await share.makeRoom(never, noStage)
  share.setVideoBusy(false)
  const release = await share.enter()
  release()
  const failed = events.find((e) => e.state === 'restore-failed')
  assert.ok(failed && 'models' in failed && failed.models.includes(QWEN.model))
  assert.equal(share.state().state, 'restore-failed')
})

test('a server that is not LM Studio, or refuses, is left alone', async () => {
  const notLmStudio: ModelServer = {
    listLoaded: async () => null,
    unload: async () => { throw new Error('must not unload') },
    load: async () => { throw new Error('must not load') },
  }
  for (const server of [null, notLmStudio]) {
    const { share } = setup(server)
    share.setVideoBusy(true)
    assert.equal(await share.makeRoom(never, noStage), 'nothing')
    share.setVideoBusy(false)
    ;(await share.enter())()
  }
})

test('a video stopped while it waits for a chat unloads nothing and lets chats carry on', async () => {
  const { server, state } = fakeServer([QWEN])
  const { share } = setup(server)
  const release = await share.enter()
  let stopped = false
  share.setVideoBusy(true)
  const room = share.makeRoom(() => stopped, noStage)
  await new Promise((r) => setTimeout(r, 40))
  stopped = true
  assert.equal(await room, 'nothing')
  release()
  share.setVideoBusy(false)
  ;(await share.enter())()
  assert.deepEqual(state.unloads, [])
})

test('a chat stopped while it waits leaves nothing behind', async () => {
  const { server, state } = fakeServer([QWEN])
  const { share } = setup(server)
  share.setVideoBusy(true)
  await share.makeRoom(never, noStage)
  const stop = new AbortController()
  const waiting = share.enter(stop.signal)
  stop.abort()
  await assert.rejects(waiting)
  // Still in the same run of videos: a second video finds nothing loaded and no chat counted as running.
  assert.equal(await share.makeRoom(never, noStage), 'nothing')
  assert.equal(state.unloads.length, 1)
})

test('the note survives a restart of Mission Control, so the model still comes back', async () => {
  const { server, state } = fakeServer([QWEN])
  const first = setup(server)
  first.share.setVideoBusy(true)
  await first.share.makeRoom(never, noStage)

  const second = setup(server, first.notePath)
  assert.equal(second.share.state().state, 'held')
  second.share.restoreNow()
  assert.ok(await waitFor(() => state.loads.length === 1))
  assert.deepEqual(state.loads[0], QWEN)
  assert.ok(await waitFor(() => (JSON.parse(readFileSync(first.notePath, 'utf8')) as { models: unknown[] }).models.length === 0), 'the note is cleared once it is back')
})

test('a model loaded again by hand during the videos is not loaded a second time', async () => {
  const { server, state } = fakeServer([QWEN])
  const { share } = setup(server)
  share.setVideoBusy(true)
  await share.makeRoom(never, noStage)
  state.loaded.push(QWEN)   // loaded by hand in LM Studio
  share.setVideoBusy(false)
  share.restoreNow()
  assert.ok(await waitFor(() => share.state().state === 'free'))
  assert.equal(state.loads.length, 0)
  assert.equal(state.loaded.length, 1)
})

test('a model loaded again by hand between videos is unloaded for the next one and still comes back once', async () => {
  const { server, state } = fakeServer([QWEN])
  const { share } = setup(server)
  share.setVideoBusy(true)
  await share.makeRoom(never, noStage)
  state.loaded.push(QWEN)
  assert.equal(await share.makeRoom(never, noStage), 'unloaded', 'the next video is not refused')
  assert.equal(state.loaded.length, 0)
  share.setVideoBusy(false)
  share.restoreNow()
  assert.ok(await waitFor(() => state.loads.length === 1))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(state.loads.length, 1)
})

test('how much the local models take: their files, plus room for the runtime and a cache that grows with the context', async () => {
  const GIB = 1024 ** 3
  // JB's model: an 11 GB file at a 64k context comes to about 14 GB, as measured on his card.
  const jbs = { ...QWEN, sizeBytes: 11e9, config: { context_length: 65_536 } }
  assert.equal(estimatedBytes(jbs), 11e9 + 3 * GIB)
  assert.equal(estimatedBytes({ ...jbs, config: { context_length: 65_536, offload_kv_cache_to_gpu: false } }), 11e9 + GIB, 'a cache kept in system memory is not counted')
  const { server } = fakeServer([jbs, { ...QWEN, instanceId: 'second', sizeBytes: 2e9 }])
  assert.equal(await setup(server).share.loadedBytes(), 11e9 + 3 * GIB + 2e9 + 2 * GIB, 'each loaded model counts')
  assert.equal(await setup(null).share.loadedBytes(), 0)
})

test('an unload that timed out but happened anyway is still noted, so the model comes back', async () => {
  const { server, state } = fakeServer([QWEN])
  server.unload = async (instanceId) => { state.loaded = state.loaded.filter((m) => m.instanceId !== instanceId); return false }
  const { share } = setup(server)
  share.setVideoBusy(true)
  assert.equal(await share.makeRoom(never, noStage), 'unloaded')
  share.setVideoBusy(false)
  share.restoreNow()
  assert.ok(await waitFor(() => state.loads.length === 1))
})

test('a chat stopped while the model is being loaded back stops at once', async () => {
  let finishLoad!: () => void
  let loaded = true
  const slow: ModelServer = {
    listLoaded: async () => loaded ? [QWEN] : [],
    unload: async () => { loaded = false; return true },
    load: () => new Promise<boolean>((r) => { finishLoad = () => r(true) }),
  }
  const { share } = setup(slow)
  share.setVideoBusy(true)
  await share.makeRoom(never, noStage)
  share.setVideoBusy(false)
  const stop = new AbortController()
  const waiting = share.enter(stop.signal)
  await new Promise((r) => setTimeout(r, 30))
  stop.abort()
  await assert.rejects(waiting)
  finishLoad()
  await share.settled()
})

test('the "could not be loaded" notice goes once the model is loaded by hand', async () => {
  const { server, state } = fakeServer([QWEN], { loadWorks: false })
  const { share } = setup(server)
  share.setVideoBusy(true)
  await share.makeRoom(never, noStage)
  share.setVideoBusy(false)
  ;(await share.enter())()
  assert.equal(share.state().state, 'restore-failed')
  state.loaded.push(QWEN)
  share.restoreNow()   // the Chat page opened again
  assert.ok(await waitFor(() => share.state().state === 'free'))
})

test('once a model is back, its context window is learned again before the page is told', async () => {
  const { server } = fakeServer([QWEN])
  const order: string[] = []
  const share = new CardShare({
    server: () => server,
    freeVideoMemory: async () => {},
    onLoadedBack: async () => { order.push('learned') },
    notePath: join(mkdtempSync(join(tmpdir(), 'mc-card-')), 'card-share.json'),
    emit: (e) => { if (e.state === 'free') order.push('free') },
    pollMs: 10,
  })
  share.setVideoBusy(true)
  await share.makeRoom(never, noStage)
  share.setVideoBusy(false)
  ;(await share.enter())()
  assert.deepEqual(order, ['learned', 'free'])
})

test('a damaged note is ignored rather than loading something unexpected', async () => {
  const { server, state } = fakeServer([])
  const notePath = join(mkdtempSync(join(tmpdir(), 'mc-card-')), 'card-share.json')
  writeFileSync(notePath, JSON.stringify({ models: [{ model: 42 }, { model: 'x', instanceId: 'x', config: { context_length: 'lots' } }] }))
  const { share } = setup(server, notePath)
  share.restoreNow()
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(state.loads.map((m) => m.model), ['x'], 'only a well-formed entry, with its bad setting dropped')
  assert.deepEqual(state.loads[0]!.config, {})
})
