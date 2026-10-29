// Run with: npm test
// The video queue's Storyboard side, against a fake ComfyUI: picture jobs keep a stripped PNG under a new picture id,
// each recipe takes only its own kind of output, and a film's rows are out of reach of the Video page's methods.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { openDatabase } from '../src/store/db.js'
import { VideoJobs, type VideoEvent } from '../src/video/jobs.js'
import type { Recipe } from '../src/video/recipes.js'

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const SECRET = 'the story of Spot and Nipper'
const PNG = (() => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(960, 0); ihdr.writeUInt32BE(544, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from(`prompt\0${SECRET}`, 'latin1')), pngChunk('IDAT', Buffer.from('pixels')), pngChunk('IEND', Buffer.alloc(0))])
})()
const MP4 = (() => {
  const box = (type: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]) }
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('mvhd', Buffer.alloc(4))), box('mdat', Buffer.from('frames'))])
})()

type OutputFile = { filename: string; subfolder: string; type: string }
interface FakeOptions { outputs?: OutputFile[]; body?: Buffer; hang?: boolean }

async function fakeComfy(opts: FakeOptions = {}) {
  const sockets = new Map<string, WebSocket>()
  const prompts: unknown[] = []
  const views: string[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/system_stats') {
      return json({ system: { comfyui_version: '0.9.9', argv: ['main.py'] }, devices: [{ name: 'Fake GPU', vram_total: 16 * 1024 ** 3, vram_free: 15 * 1024 ** 3 }] })
    }
    if (url.pathname.startsWith('/object_info/')) return json({ [decodeURIComponent(url.pathname.slice('/object_info/'.length))]: { input: {} } })
    if (url.pathname.startsWith('/models/')) return json(['model.safetensors'])
    if (url.pathname === '/prompt' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { prompt: unknown; client_id: string }
        prompts.push(parsed.prompt)
        json({ prompt_id: 'p-1', number: 1, node_errors: {} })
        if (opts.hang) return
        setTimeout(() => sockets.get(parsed.client_id)!.send(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: 'p-1' } })), 20)
      })
      return
    }
    if (url.pathname === '/history/p-1') {
      return json({ 'p-1': { outputs: { '9': { images: opts.outputs ?? [{ filename: 'still_00001_.png', subfolder: 'mission-control', type: 'temp' }] } } } })
    }
    if (url.pathname === '/view') {
      views.push(url.search)
      res.writeHead(200)
      return res.end(opts.body ?? PNG)
    }
    if (url.pathname === '/free' || url.pathname === '/interrupt' || url.pathname.startsWith('/api/jobs/')) return json({})
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws, req) => { sockets.set(new URL(req.url!, 'http://x').searchParams.get('clientId')!, ws) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, prompts, views,
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); server.close(() => r()) }),
  }
}

const PICTURE: Recipe = {
  id: 'test-picture', name: 'Test picture', description: '', hardware: '', minFreeVramGb: 1, output: 'picture',
  params: { prompt: { kind: 'text', maxLength: 100, required: true } },
  models: [{ folder: 'diffusion_models', file: 'model.safetensors' }],
  build: (values) => ({ '1': { class_type: 'EmptyImage', inputs: { width: 8, height: 8 } }, '9': { class_type: 'PreviewImage', inputs: { images: ['1', 0], text: values.prompt } } }),
}
const CLIP: Recipe = { ...PICTURE, id: 'test-clip', output: 'video', build: () => ({ '9': { class_type: 'SaveVideo', inputs: {} } }) }
const FILM = 'f'.repeat(32)

function setup(comfyUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-film-queue-'))
  const db = openDatabase(join(dir, 'test.sqlite'))
  const events: VideoEvent[] = []
  const jobs = new VideoJobs(db, join(dir, 'media'), () => ({ comfyUrl, freeAfterJob: false }), (e) => events.push(e))
  const finished = (id: string) => new Promise<VideoEvent>((resolve) => {
    const timer = setInterval(() => {
      const end = events.find((e) => e.id === id && ['done', 'failed', 'cancelled'].includes(e.status))
      if (end) { clearInterval(timer); resolve(end) }
    }, 10)
  })
  return { dir, db, jobs, events, finished }
}

test('a picture job keeps a stripped PNG under a new picture id, and writes no video', async () => {
  const comfy = await fakeComfy()
  const { dir, db, jobs, finished } = setup(comfy.url)
  try {
    const id = jobs.submitFilm(PICTURE, { prompt: SECRET }, FILM)
    const end = await finished(id)
    assert.equal(end.status, 'done', end.error)
    const pictureId = jobs.pictureOf(id)
    assert.match(pictureId ?? '', /^[0-9a-f]{32}$/)
    assert.ok(jobs.hasImage(pictureId), 'stored like an uploaded picture')
    const saved = readFileSync(join(dir, 'media', 'inputs', `${pictureId}.png`))
    assert.equal(saved.includes(Buffer.from(SECRET)), false, 'the prompt text chunk is gone')
    assert.ok(saved.includes(Buffer.from('pixels')))
    assert.equal(readdirSync(join(dir, 'media')).some((n) => n.endsWith('.mp4')), false)
    const row = db.prepare('SELECT kind, film_id AS filmId FROM videos WHERE id = ?').get(id)
    assert.deepEqual(row, { kind: 'picture', filmId: FILM })
    assert.match(comfy.views[0]!, /type=temp/, 'the temp output was fetched')
  } finally { await comfy.close() }
})

test('each recipe takes only its own kind of output', async () => {
  const mp4Only = await fakeComfy({ outputs: [{ filename: 'clip_00001_.mp4', subfolder: 'mission-control', type: 'output' }], body: MP4 })
  try {
    const { jobs, finished } = setup(mp4Only.url)
    const end = await finished(jobs.submitFilm(PICTURE, { prompt: 'x' }, FILM))
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /saved no picture/)
  } finally { await mp4Only.close() }

  const pngOnly = await fakeComfy({ outputs: [{ filename: 'still_00001_.png', subfolder: 'mission-control', type: 'output' }] })
  try {
    const { jobs, finished } = setup(pngOnly.url)
    const end = await finished(jobs.submitFilm(CLIP, { prompt: 'x' }, FILM))
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /saved no video/)
  } finally { await pngOnly.close() }

  const tempVideo = await fakeComfy({ outputs: [{ filename: 'clip_00001_.mp4', subfolder: 'mission-control', type: 'temp' }], body: MP4 })
  try {
    const { jobs, finished } = setup(tempVideo.url)
    assert.equal((await finished(jobs.submitFilm(CLIP, { prompt: 'x' }, FILM))).status, 'failed', 'videos only from the output folder')
  } finally { await tempVideo.close() }
})

test('a picture job whose file is not a PNG fails', async () => {
  const comfy = await fakeComfy({ body: Buffer.from('<html>not a picture</html>') })
  const { jobs, finished } = setup(comfy.url)
  try {
    const end = await finished(jobs.submitFilm(PICTURE, { prompt: 'x' }, FILM))
    assert.equal(end.status, 'failed')
    assert.match(end.error!, /not a PNG picture/)
  } finally { await comfy.close() }
})

test('a film recipe is out of reach of the Video page\'s submit', () => {
  const { jobs } = setup('http://127.0.0.1:9')
  assert.throws(() => jobs.submit('test-picture', { prompt: 'x' }), /no recipe with that name/)
  assert.throws(() => jobs.submitFilm(PICTURE, { prompt: 'x' }, 'not-an-id'), /film/)
})

test('a film\'s rows are hidden from the Video page and refused by its methods', async () => {
  const comfy = await fakeComfy({ outputs: [{ filename: 'clip_00001_.mp4', subfolder: 'mission-control', type: 'output' }], body: MP4 })
  const { db, jobs, finished } = setup(comfy.url)
  try {
    const clip = jobs.submitFilm(CLIP, { prompt: 'x' }, FILM)
    assert.equal((await finished(clip)).status, 'done')
    assert.equal(jobs.list().length, 0, 'not on the Video page')
    assert.equal(jobs.filePath(clip), null, 'no Video page link to it')
    assert.equal(jobs.keep(clip, true), false)
    assert.equal(jobs.delete(clip), false)
    assert.equal(jobs.clearUnkept([clip]), 0)
    const row = db.prepare('SELECT deleted_at AS deletedAt, kept FROM videos WHERE id = ?').get(clip)
    assert.deepEqual(row, { deletedAt: null, kept: 0 })
    assert.ok(jobs.filmFilePath(clip, FILM), 'the film itself still finds its clip')
    assert.equal(jobs.filmFilePath(clip, 'e'.repeat(32)), null, 'but not another film')
  } finally { await comfy.close() }
})

test('the Video page cannot stop a film\'s job; the film can', async () => {
  const comfy = await fakeComfy({ hang: true })
  const { jobs, events } = setup(comfy.url)
  try {
    const id = jobs.submitFilm(PICTURE, { prompt: 'x' }, FILM)
    for (let i = 0; i < 200 && comfy.prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(jobs.cancel(id), false)
    assert.equal(jobs.cancelFilmJob(id, 'e'.repeat(32)), false, 'not by another film')
    assert.equal(jobs.cancelFilmJob(id, FILM), true)
    for (let i = 0; i < 200 && !events.some((e) => e.id === id && e.status === 'cancelled'); i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(events.some((e) => e.id === id && e.status === 'cancelled'))
  } finally { await comfy.close() }
})

test('a picture download over 16 MB is refused', async () => {
  const comfy = await fakeComfy({ body: Buffer.alloc(17 * 1024 * 1024) })
  const { jobs, finished } = setup(comfy.url)
  try {
    assert.equal((await finished(jobs.submitFilm(PICTURE, { prompt: 'x' }, FILM))).status, 'failed')
  } finally { await comfy.close() }
})
