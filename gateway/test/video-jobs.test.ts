// Run with: npm test
// The video queue against a fake ComfyUI (HTTP + WebSocket on a random loopback port).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { openDatabase } from '../src/store/db.js'
import { VideoJobs, VideoRequestError, listensBeyondThisComputer, type VideoEvent, type VideoCardShare } from '../src/video/jobs.js'
import { RECIPES } from '../src/video/recipes.js'

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}
const SECRET_PROMPT = Buffer.from('"prompt": "my private prompt"')
const MP4 = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('udta', SECRET_PROMPT)), box('mdat', Buffer.from('frames'))])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

interface FakeOptions { argv?: string[]; vramTotalGb?: number; vramFreeGb?: number | (() => number); missingNode?: string; fail?: boolean; videoBody?: Buffer; hang?: boolean; statsDelayMs?: number; vramFreeSequence?: number[] }

async function fakeComfy(opts: FakeOptions = {}) {
  const sockets = new Map<string, WebSocket>()
  const prompts: unknown[] = []
  const uploads: Array<{ name: string; body: Buffer }> = []
  let freed = 0
  let cancelled = 0
  let statsCalls = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/system_stats') {
      statsCalls++
      // vramFreeSequence: free memory as ComfyUI reports it on each ask (the last value repeats), like memory coming back after a job.
      const seq = opts.vramFreeSequence
      const freeGb = seq ? seq[Math.min(statsCalls - 1, seq.length - 1)]! : typeof opts.vramFreeGb === 'function' ? opts.vramFreeGb() : (opts.vramFreeGb ?? 15)
      const stats = { system: { comfyui_version: '0.9.9', argv: opts.argv ?? ['main.py'] }, devices: [{ name: 'Fake GPU', vram_total: (opts.vramTotalGb ?? 16) * 1024 ** 3, vram_free: freeGb * 1024 ** 3 }] }
      // A slow answer holds a job in its checks before anything reaches ComfyUI (the window two quick presses fell into).
      if (opts.statsDelayMs) return void setTimeout(() => json(stats), opts.statsDelayMs)
      return json(stats)
    }
    if (url.pathname.startsWith('/object_info/')) {
      const cls = decodeURIComponent(url.pathname.slice('/object_info/'.length))
      return json(cls === opts.missingNode ? {} : { [cls]: { input: {} } })
    }
    if (url.pathname.startsWith('/models/')) {
      const folder = url.pathname.slice('/models/'.length)
      return json(RECIPES[0]!.models.filter((m) => m.folder === folder).map((m) => m.file))
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { prompt: unknown; client_id: string }
        prompts.push(parsed.prompt)
        json({ prompt_id: 'p-1', number: 1, node_errors: {} })
        if (opts.hang) return
        const ws = sockets.get(parsed.client_id)!
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'p-1' } }))
          ws.send(JSON.stringify({ type: 'progress', data: { value: 3, max: 8, prompt_id: 'p-1', node: '15' } }))
          const header = Buffer.alloc(8); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4)
          ws.send(Buffer.concat([header, JPEG]))
          if (opts.fail) ws.send(JSON.stringify({ type: 'execution_error', data: { prompt_id: 'p-1', node_type: 'VAEDecodeTiled', exception_message: 'out of memory' } }))
          else ws.send(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: 'p-1' } }))
        }, 20)
      })
      return
    }
    if (url.pathname === '/history/p-1') {
      return json({ 'p-1': { outputs: { '30': { images: [{ filename: 'job_00001_.mp4', subfolder: 'mission-control', type: 'output' }] } } } })
    }
    if (url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'video/mp4' })
      return res.end(opts.videoBody ?? MP4)
    }
    if (url.pathname === '/upload/image' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const name = /filename="([^"]+)"/.exec(body.toString('latin1'))?.[1] ?? ''
        uploads.push({ name, body })
        json({ name, subfolder: 'mission-control', type: 'input' })
      })
      return
    }
    if (url.pathname === '/free') { freed++; return json({}) }
    if (url.pathname === '/interrupt' || url.pathname.startsWith('/api/jobs/')) { cancelled++; return json({}) }
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws, req) => { sockets.set(new URL(req.url!, 'http://x').searchParams.get('clientId')!, ws) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    prompts, uploads, freed: () => freed, cancelled: () => cancelled, statsCalls: () => statsCalls,
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); server.close(() => r()) }),
  }
}

// Memory is waited for briefly here; the real wait is longer (see MEMORY_WAIT_MS in jobs.ts).
function setup(comfyUrl: string, timing = { memoryWaitMs: 1000, memoryPollMs: 20, recentFreeMs: 30_000 }, cardShare?: VideoCardShare) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-video-'))
  const db = openDatabase(join(dir, 'test.sqlite'))
  const events: VideoEvent[] = []
  const jobs = new VideoJobs(db, join(dir, 'media'), () => ({ comfyUrl, freeAfterJob: true }), (e) => events.push(e), timing, cardShare)
  const finished = (id: string) => new Promise<VideoEvent>((resolve) => {
    const timer = setInterval(() => {
      const end = events.find((e) => e.id === id && ['done', 'failed', 'cancelled'].includes(e.status))
      if (end) { clearInterval(timer); resolve(end) }
    }, 10)
  })
  return { dir, db, jobs, events, finished }
}

test('a job runs end to end: progress, a preview, and a clean file on disk', async () => {
  const comfy = await fakeComfy()
  const { dir, jobs, events, finished } = setup(comfy.url)
  try {
    const id = jobs.submit('ltx25-t2v', { prompt: 'a dog on a beach', seconds: 2 })
    const end = await finished(id)
    assert.equal(end.status, 'done', end.error)
    assert.ok(events.some((e) => e.id === id && e.step === 3 && e.steps === 8), 'progress was passed on')
    const preview = events.find((e) => e.preview)
    assert.equal(preview?.preview?.mime, 'image/jpeg')
    assert.equal(Buffer.from(preview!.preview!.data, 'base64').equals(JPEG), true)
    const file = jobs.filePath(id)
    assert.equal(file, join(dir, 'media', `${id}.mp4`))
    const saved = readFileSync(file!)
    assert.equal(saved.length, MP4.length)
    assert.equal(saved.includes(SECRET_PROMPT), false, 'the prompt metadata was removed')
    // The memory is handed back right after the file is saved, so allow it a moment.
    for (let i = 0; i < 50 && comfy.freed() === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(comfy.freed(), 1, 'graphics memory handed back after the job')
    const graph = comfy.prompts[0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    const save = Object.values(graph).find((n) => n.class_type === 'SaveVideo')!
    assert.equal(save.inputs['filename_prefix'], `mission-control/${id}`)
    const encode = Object.values(graph).filter((n) => n.class_type === 'CLIPTextEncode').map((n) => n.inputs['text'])
    assert.ok(encode.includes('a dog on a beach'))
    assert.equal(jobs.list()[0]!.status, 'done')
  } finally {
    await comfy.close()
  }
})

test('bad parameters and unknown recipes are refused before anything is queued', async () => {
  const { jobs } = setup('http://127.0.0.1:9')
  assert.throws(() => jobs.submit('nope', {}), VideoRequestError)
  assert.throws(() => jobs.submit('ltx25-t2v', { prompt: '' }), /prompt is required/)
  assert.throws(() => jobs.submit('ltx25-t2v', { prompt: 'x', graph: {} }), /unknown parameter: graph/)
  assert.equal(jobs.list().length, 0)
})

test('a ComfyUI open to the network is refused', async () => {
  const comfy = await fakeComfy({ argv: ['main.py', '--listen'] })
  const { jobs, finished } = setup(comfy.url)
  try {
    const end = await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /open to your network/)
    assert.equal(comfy.prompts.length, 0, 'nothing was sent')
  } finally { await comfy.close() }
})

test('--listen 127.0.0.1 is fine', async () => {
  const comfy = await fakeComfy({ argv: ['main.py', '--listen', '127.0.0.1'] })
  const { jobs, finished } = setup(comfy.url)
  try {
    assert.equal((await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))).status, 'done')
  } finally { await comfy.close() }
})

test('too little free graphics memory stops the job with a plain reason', async () => {
  const comfy = await fakeComfy({ vramFreeGb: 3 })
  const { jobs, events, finished } = setup(comfy.url)
  try {
    const id = jobs.submit('ltx25-t2v', { prompt: 'x' })
    const end = await finished(id)
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /Not enough free graphics memory: 3\.0 GB free/)
    assert.ok(!events.some((e) => e.id === id && e.stage === 'Waiting for graphics memory'), 'no wait when no job has just finished')
    assert.equal(comfy.prompts.length, 0)
  } finally { await comfy.close() }
})

test('memory still being handed back after the last job: the next one waits for it instead of failing', async () => {
  // The first job sees a free card; the second sees the first's memory still in use for two asks, then free.
  const comfy = await fakeComfy({ vramFreeSequence: [15, 3, 3, 15] })
  const { jobs, events, finished } = setup(comfy.url)
  try {
    assert.equal((await finished(jobs.submit('ltx25-t2v', { prompt: 'first' }))).status, 'done')
    const second = jobs.submit('ltx25-t2v', { prompt: 'second' })
    assert.equal((await finished(second)).status, 'done')
    assert.ok(events.some((e) => e.id === second && e.stage === 'Waiting for graphics memory'), 'the page is told it is waiting')
    assert.ok(events.some((e) => e.id === second && e.stage === 'Getting the video ready'), 'and when the wait is over')
    assert.ok(comfy.statsCalls() >= 4, 'ComfyUI was asked again')
    assert.equal(comfy.prompts.length, 2)
  } finally { await comfy.close() }
})

test('a job waiting for graphics memory can be stopped', { timeout: 10_000 }, async () => {
  // A first job runs on a free card; after it the card stays full, so the second waits until it is stopped.
  const comfy = await fakeComfy({ vramFreeSequence: [15, 3] })
  const { jobs, events, finished } = setup(comfy.url, { memoryWaitMs: 5000, memoryPollMs: 200, recentFreeMs: 30_000 })
  try {
    assert.equal((await finished(jobs.submit('ltx25-t2v', { prompt: 'first' }))).status, 'done')
    const id = jobs.submit('ltx25-t2v', { prompt: 'x' })
    assert.ok(await waitFor(() => events.some((e) => e.id === id && e.stage === 'Waiting for graphics memory')))
    assert.equal(jobs.cancel(id), true)
    assert.ok(await waitFor(() => events.some((e) => e.id === id && e.status === 'cancelled'), 1000), 'it stops without waiting the full time')
    assert.equal(comfy.prompts.length, 1, 'only the first job was sent')
  } finally {
    for (const v of jobs.list()) jobs.cancel(v.id)
    await comfy.close()
  }
})

test('a missing node is named, and nothing is sent', async () => {
  const comfy = await fakeComfy({ missingNode: 'LTXVLatentUpsampler' })
  const { jobs, finished } = setup(comfy.url)
  try {
    const end = await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /node LTXVLatentUpsampler/)
    assert.equal(comfy.prompts.length, 0)
  } finally { await comfy.close() }
})

test('an error inside ComfyUI is reported', async () => {
  const comfy = await fakeComfy({ fail: true })
  const { jobs, finished } = setup(comfy.url)
  try {
    const end = await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /VAEDecodeTiled: out of memory/)
  } finally { await comfy.close() }
})

test('something that is not an MP4 is never saved', async () => {
  const comfy = await fakeComfy({ videoBody: Buffer.from('<html><script>alert(1)</script></html>') })
  const { jobs, finished, dir } = setup(comfy.url)
  try {
    const id = jobs.submit('ltx25-t2v', { prompt: 'x' })
    const end = await finished(id)
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /not an MP4/)
    assert.equal(existsSync(join(dir, 'media', `${id}.mp4`)), false)
    assert.equal(jobs.filePath(id), null)
  } finally { await comfy.close() }
})

test('a running job can be stopped', async () => {
  const comfy = await fakeComfy({ hang: true })
  const { jobs, finished } = setup(comfy.url)
  try {
    const id = jobs.submit('ltx25-t2v', { prompt: 'x' })
    while (comfy.prompts.length === 0) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(jobs.cancel(id), true)
    assert.equal((await finished(id)).status, 'cancelled')
    assert.ok(comfy.cancelled() > 0, 'ComfyUI was told to stop')
    for (let i = 0; i < 50 && comfy.freed() === 0; i++) await new Promise((r) => setTimeout(r, 10))   // let the job hand memory back before the fake closes
  } finally { await comfy.close() }
})

// Waits up to a few seconds for a condition, so a broken queue fails the test instead of hanging it.
async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  return check()
}

// The timeout turns a broken queue into a failure: there, the first job can no longer be stopped and would hold the run open.
test('pressing Make video twice quickly: the second waits its turn instead of starting alongside the first', { timeout: 10_000 }, async () => {
  const comfy = await fakeComfy({ hang: true, statsDelayMs: 150 })
  const { jobs, events, finished } = setup(comfy.url)
  try {
    const first = jobs.submit('ltx25-t2v', { prompt: 'first' })
    await new Promise((r) => setTimeout(r, 20))   // the first job is now in its checks, not yet in ComfyUI
    const second = jobs.submit('ltx25-t2v', { prompt: 'second' })
    assert.ok(await waitFor(() => comfy.prompts.length > 0), 'the first job reaches ComfyUI')
    await new Promise((r) => setTimeout(r, 300))   // time for a wrongly started second job to reach ComfyUI too
    assert.equal(comfy.prompts.length, 1, 'only one job is sent to ComfyUI')
    assert.ok(!events.some((e) => e.id === second && e.status === 'running'), 'the second job is still waiting')
    assert.deepEqual(jobs.list().map((v) => [v.id, v.status]), [[second, 'queued'], [first, 'running']])

    // Stopping the first lets the second start.
    assert.equal(jobs.cancel(first), true)
    assert.ok(await waitFor(() => events.some((e) => e.id === first && e.status === 'cancelled')), 'the first job stops')
    assert.ok(await waitFor(() => comfy.prompts.length === 2), 'then the second job starts')
    assert.equal(jobs.cancel(second), true)
    assert.equal((await finished(second)).status, 'cancelled')
    await waitFor(() => comfy.freed() === 2, 500)
  } finally {
    for (const v of jobs.list()) jobs.cancel(v.id)   // on a failure, nothing is left running to keep the test alive
    await comfy.close()
  }
})

test('a job can be stopped while it is still being checked, before anything reaches ComfyUI', { timeout: 10_000 }, async () => {
  const comfy = await fakeComfy({ hang: true, statsDelayMs: 150 })
  const { jobs, events } = setup(comfy.url)
  try {
    const id = jobs.submit('ltx25-t2v', { prompt: 'x' })
    assert.ok(await waitFor(() => comfy.statsCalls() > 0), 'the job is in its checks')
    assert.equal(jobs.cancel(id), true, 'a job in its checks can be stopped')
    assert.ok(events.some((e) => e.id === id && e.stage === 'Stopping'), 'the page is told at once that it is stopping')
    assert.ok(await waitFor(() => events.some((e) => e.id === id && e.status === 'cancelled')), 'it ends as stopped')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(comfy.prompts.length, 0, 'nothing was sent to ComfyUI')
  } finally {
    for (const v of jobs.list()) jobs.cancel(v.id)
    await comfy.close()
  }
})

test('only a loopback ComfyUI address is used', async () => {
  const { jobs, finished } = setup('http://192.168.1.50:8188')
  const end = await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))
  assert.equal(end.status, 'failed')
  assert.match(end.error!, /must run on this computer/)
})

test('jobs left running by a restart are marked failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-video-'))
  const db = openDatabase(join(dir, 'test.sqlite'))
  db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at) VALUES ('${'a'.repeat(32)}', 'ltx25-t2v', '{}', 'running', 1)`).run()
  const jobs = new VideoJobs(db, join(dir, 'media'), () => ({ comfyUrl: 'http://127.0.0.1:9', freeAfterJob: false }), () => {})
  assert.equal(jobs.list()[0]!.status, 'failed')
})

test('every way of opening ComfyUI to the network is spotted', () => {
  for (const argv of [['--listen'], ['--listen', '0.0.0.0'], ['--listen=0.0.0.0'], ['--listen', '192.168.1.5'], ['--listen', '127.0.0.1,0.0.0.0'], ['--listen', '--port', '8188']]) {
    assert.equal(listensBeyondThisComputer(['main.py', ...argv]), true, argv.join(' '))
  }
  for (const argv of [[], ['--listen', '127.0.0.1'], ['--listen=localhost'], ['--port', '8188']]) {
    assert.equal(listensBeyondThisComputer(['main.py', ...argv]), false, argv.join(' '))
  }
})

test('deleting a video removes its file and its link stops working', async () => {
  const comfy = await fakeComfy()
  const { jobs, finished, dir } = setup(comfy.url)
  try {
    const id = jobs.submit('ltx25-t2v', { prompt: 'x' })
    assert.equal((await finished(id)).status, 'done')
    assert.equal(jobs.delete(id), true)
    assert.equal(existsSync(join(dir, 'media', `${id}.mp4`)), false)
    assert.equal(jobs.filePath(id), null)
    assert.equal(jobs.list().length, 0)
    assert.equal(jobs.delete('../../etc'), false)
  } finally { await comfy.close() }
})

test('clearing removes every video that is not starred, and leaves the starred ones', async () => {
  const comfy = await fakeComfy()
  const { jobs, finished, dir } = setup(comfy.url)
  try {
    const starred = jobs.submit('ltx25-t2v', { prompt: 'keep me' })
    assert.equal((await finished(starred)).status, 'done')
    const other = jobs.submit('ltx25-t2v', { prompt: 'clear me' })
    assert.equal((await finished(other)).status, 'done')
    assert.equal(jobs.keep(starred, true), true)
    assert.deepEqual(jobs.list().map((v) => [v.id, v.kept]), [[other, false], [starred, true]])

    assert.equal(jobs.clearUnkept([starred, other, '../../etc']), 1)
    assert.deepEqual(jobs.list().map((v) => v.id), [starred])
    assert.equal(existsSync(join(dir, 'media', `${starred}.mp4`)), true)
    assert.equal(existsSync(join(dir, 'media', `${other}.mp4`)), false)

    // Taking the star off lets the next clear remove it; a deleted or made-up id can't be starred.
    assert.equal(jobs.keep(starred, false), true)
    assert.equal(jobs.clearUnkept([starred]), 1)
    assert.equal(jobs.list().length, 0)
    assert.equal(jobs.keep(other, true), false)
    assert.equal(jobs.keep('../../etc', true), false)
  } finally { await comfy.close() }
})

test('clearing touches only the videos the page named, and never one still queued or running', async () => {
  const comfy = await fakeComfy({ hang: true })
  const { jobs, finished, db, dir } = setup(comfy.url)
  try {
    // Two finished videos the page has and hasn't seen, made straight in the table (the fake ComfyUI hangs every job here).
    const seen = 'a'.repeat(32)
    const unseen = 'b'.repeat(32)
    for (const id of [seen, unseen]) {
      db.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at) VALUES (?, 'ltx25-t2v', '{}', 'done', ?)`).run(id, Date.now())
      writeFileSync(join(dir, 'media', `${id}.mp4`), MP4)
    }
    const running = jobs.submit('ltx25-t2v', { prompt: 'running' })
    while (comfy.prompts.length === 0) await new Promise((r) => setTimeout(r, 10))
    const queued = jobs.submit('ltx25-t2v', { prompt: 'queued' })

    assert.equal(jobs.clearUnkept([seen, running, queued]), 1)
    assert.deepEqual(jobs.list().map((v) => v.id).sort(), [unseen, running, queued].sort())
    assert.equal(existsSync(join(dir, 'media', `${seen}.mp4`)), false)
    assert.equal(existsSync(join(dir, 'media', `${unseen}.mp4`)), true)

    jobs.cancel(queued)
    assert.equal(jobs.cancel(running), true)
    assert.equal((await finished(running)).status, 'cancelled')
    for (let i = 0; i < 50 && comfy.freed() === 0; i++) await new Promise((r) => setTimeout(r, 10))
  } finally { await comfy.close() }
})

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from('x')), chunk('IEND', Buffer.alloc(0))])
}

test('picture to video: the picture is checked, copied into ComfyUI under our name, and used as the first frame', async () => {
  const comfy = await fakeComfy()
  const { jobs, finished } = setup(comfy.url)
  try {
    const picture = png(1600, 900)
    const uploaded = jobs.uploadImage(picture.toString('base64'))
    assert.match(uploaded.id, /^[0-9a-f]{32}$/)
    assert.deepEqual([uploaded.type, uploaded.width, uploaded.height], ['png', 1600, 900])
    assert.throws(() => jobs.uploadImage(Buffer.from('<svg/>').toString('base64')), /not a PNG, JPEG or WebP/)
    assert.throws(() => jobs.submit('ltx25-i2v', { prompt: 'waves', image: 'f'.repeat(32) }), /not uploaded/)
    assert.throws(() => jobs.submit('ltx25-i2v', { prompt: 'waves', image: '../../etc/passwd' }), VideoRequestError)

    const id = jobs.submit('ltx25-i2v', { prompt: 'waves roll in', image: uploaded.id, seconds: 2 })
    const end = await finished(id)
    assert.equal(end.status, 'done', end.error)
    assert.equal(comfy.uploads.length, 1)
    assert.equal(comfy.uploads[0]!.name, `${uploaded.id}.png`)
    assert.ok(comfy.uploads[0]!.body.includes(picture), 'the exact picture bytes were sent')
    const graph = comfy.prompts[0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    const nodes = Object.values(graph)
    assert.equal(nodes.find((n) => n.class_type === 'LoadImage')?.inputs['image'], `mission-control/${uploaded.id}.png`)
    const firstFrames = nodes.filter((n) => n.class_type === 'LTXVImgToVideoInplace').map((n) => n.inputs['strength'])
    assert.deepEqual(firstFrames, [0.7, 1.0], 'the picture guides both passes, as in the ComfyUI blueprint')
  } finally { await comfy.close() }
})

// A stand-in for the card sharing (src/providers/card-share.ts): records what the queue tells it, and answers makeRoom as told.
// localGb: what LM Studio's loaded models take, until makeRoom unloads them.
function fakeCardShare(answer: 'unloaded' | 'nothing' | { error: string }, onRoom?: () => void, localGb = 0, opts: { vanish?: boolean } = {}) {
  const busy: boolean[] = []
  let rooms = 0
  let local = localGb
  const share: VideoCardShare = {
    setVideoBusy: (b) => { busy.push(b) },
    loadedBytes: async () => local * 1024 ** 3,
    settled: async () => {},
    makeRoom: async (_stopped, onStage) => {
      rooms++
      onStage('Waiting for a chat to finish')
      onRoom?.()
      if (answer === 'unloaded' || opts.vanish) local = 0
      return answer
    },
  }
  return { share, busy, rooms: () => rooms }
}

test('ComfyUI says the card is free, but LM Studio holds an 11 GB model: the model is unloaded before the video', async () => {
  // As measured on a 16 GB card: ComfyUI reported 14.4 GB free with LM Studio using 14 GB, as it counts only its own memory.
  const comfy = await fakeComfy({ vramFreeGb: 14.4 })
  const card = fakeCardShare('unloaded', undefined, 11)
  const { jobs, events, finished } = setup(comfy.url, undefined, card.share)
  try {
    const id = jobs.submit('ltx25-t2v', { prompt: 'x' })
    assert.equal((await finished(id)).status, 'done')
    assert.equal(card.rooms(), 1, 'the local model was unloaded')
    assert.ok(events.some((e) => e.id === id && e.stage === 'Making room on the graphics card'))
  } finally { await comfy.close() }
})

test('a card big enough for both: a loaded local model is left alone', async () => {
  // A 48 GB card with a 12 GB model loaded still has room for a 14 GB recipe.
  const comfy = await fakeComfy({ vramFreeGb: 40, vramTotalGb: 48 })
  const card = fakeCardShare('unloaded', undefined, 12)
  const { jobs, finished } = setup(comfy.url, undefined, card.share)
  try {
    assert.equal((await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))).status, 'done')
    assert.equal(card.rooms(), 0)
  } finally { await comfy.close() }
})

test('memory still coming back after the last video is waited for, not taken from the local model', async () => {
  const comfy = await fakeComfy({ vramFreeSequence: [15, 3, 3, 15] })
  const card = fakeCardShare('unloaded', undefined, 0)
  const { jobs, finished } = setup(comfy.url, undefined, card.share)
  try {
    assert.equal((await finished(jobs.submit('ltx25-t2v', { prompt: 'first' }))).status, 'done')
    assert.equal((await finished(jobs.submit('ltx25-t2v', { prompt: 'second' }))).status, 'done')
    assert.equal(card.rooms(), 0, 'nothing unloaded for a passing shortage of ComfyUI\'s own memory')
  } finally { await comfy.close() }
})

test('a card too full because LM Studio holds a model: the model is unloaded and the video runs', async () => {
  // Full until the model is unloaded, then free.
  let unloaded = false
  const comfy = await fakeComfy({ vramFreeGb: () => unloaded ? 15 : 3 })
  const card = fakeCardShare('unloaded', () => { unloaded = true }, 11)
  const { jobs, events, finished } = setup(comfy.url, undefined, card.share)
  try {
    const id = jobs.submit('ltx25-t2v', { prompt: 'x' })
    const end = await finished(id)
    assert.equal(end.status, 'done', end.error)
    assert.equal(card.rooms(), 1)
    assert.ok(events.some((e) => e.id === id && e.stage === 'Making room on the graphics card'))
    assert.ok(events.some((e) => e.id === id && e.stage === 'Waiting for a chat to finish'), 'the stages the card sharing reports reach the page')
    assert.ok(await waitFor(() => card.busy.at(-1) === false), 'the queue says when it is empty again')
    assert.equal(card.busy[0], true)
  } finally { await comfy.close() }
})

test('no local model loaded and a free card: nothing is unloaded', async () => {
  const comfy = await fakeComfy({ vramFreeGb: 15 })
  const card = fakeCardShare('unloaded')
  const { jobs, finished } = setup(comfy.url, undefined, card.share)
  try {
    assert.equal((await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))).status, 'done')
    assert.equal(card.rooms(), 0, 'nothing is unloaded when the card can hold both')
  } finally { await comfy.close() }
})

test('a full card with no local model loaded is refused as before, and nothing is unloaded', async () => {
  const comfy = await fakeComfy({ vramFreeGb: 3 })
  const card = fakeCardShare('unloaded', undefined, 0)
  const { jobs, finished } = setup(comfy.url, undefined, card.share)
  try {
    const end = await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /Not enough free graphics memory: 3\.0 GB free/)
    assert.equal(card.rooms(), 0)
    assert.equal(comfy.prompts.length, 0)
  } finally { await comfy.close() }
})

test('a local model that could not be unloaded: refused, with a plain reason', async () => {
  const comfy = await fakeComfy({ vramFreeGb: 14.4 })
  const card = fakeCardShare('nothing', undefined, 11)
  const { jobs, finished } = setup(comfy.url, undefined, card.share)
  try {
    const end = await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /Not enough free graphics memory: 5\.0 GB free.*Something else is using the graphics card/)
    assert.equal(card.rooms(), 1)
  } finally { await comfy.close() }
})

test('the local model went by itself just before the video (ejected, or LM Studio\'s idle timer): the video runs', async () => {
  const comfy = await fakeComfy({ vramFreeGb: 14.4 })
  const card = fakeCardShare('nothing', undefined, 11, { vanish: true })
  const { jobs, finished } = setup(comfy.url, undefined, card.share)
  try {
    const end = await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))
    assert.equal(end.status, 'done', end.error)
    assert.equal(card.rooms(), 1)
  } finally { await comfy.close() }
})

test('a card too small for the recipe anyway: the local model is not unloaded for nothing', async () => {
  const comfy = await fakeComfy({ vramFreeGb: 3, vramTotalGb: 12 })
  const card = fakeCardShare('unloaded', undefined, 8)
  const { jobs, finished } = setup(comfy.url, undefined, card.share)
  try {
    assert.equal((await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))).status, 'failed')
    assert.equal(card.rooms(), 0)
  } finally { await comfy.close() }
})

test('when the card sharing cannot make room, its reason is given', async () => {
  const comfy = await fakeComfy({ vramFreeGb: 3 })
  const card = fakeCardShare({ error: 'A chat is still running after 10 minutes.' }, undefined, 11)
  const { jobs, finished } = setup(comfy.url, undefined, card.share)
  try {
    const end = await finished(jobs.submit('ltx25-t2v', { prompt: 'x' }))
    assert.equal(end.status, 'failed')
    assert.equal(end.error, 'A chat is still running after 10 minutes.')
  } finally { await comfy.close() }
})

test('stopping the last queued video tells the card sharing the queue is empty', async () => {
  const comfy = await fakeComfy({ hang: true })
  const card = fakeCardShare('nothing')
  const { jobs, events } = setup(comfy.url, undefined, card.share)
  try {
    const first = jobs.submit('ltx25-t2v', { prompt: 'first' })
    const second = jobs.submit('ltx25-t2v', { prompt: 'second' })
    assert.ok(await waitFor(() => comfy.prompts.length === 1))
    jobs.cancel(second)
    assert.notEqual(card.busy.at(-1), false, 'still busy while the first runs')
    jobs.cancel(first)
    assert.ok(await waitFor(() => events.some((e) => e.id === first && e.status === 'cancelled')))
    assert.ok(await waitFor(() => card.busy.at(-1) === false))
  } finally { await comfy.close() }
})
