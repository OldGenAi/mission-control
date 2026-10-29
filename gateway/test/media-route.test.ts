// Run with: npm test
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// auth.ts creates ~/.missioncontrol/config.json on import, so give it a throwaway home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-media-test-'))
process.env['HOME'] = home
process.env['USERPROFILE'] = home

const ID = '0123456789abcdef0123456789abcdef'
// Real installs keep videos inside the hidden ~/.missioncontrol folder, so the test does too.
const mediaDir = path.join(home, '.missioncontrol', 'media', 'video')
fs.mkdirSync(mediaDir, { recursive: true })
const videoPath = path.join(mediaDir, `${ID}.mp4`)
fs.writeFileSync(videoPath, Buffer.from('0123456789'.repeat(10)))
const PICTURE_ID = 'fedcba9876543210fedcba9876543210'
const picturePath = path.join(mediaDir, 'inputs', `${PICTURE_ID}.png`)
fs.mkdirSync(path.dirname(picturePath), { recursive: true })
fs.writeFileSync(picturePath, Buffer.from('not really a png'))

let server: Server
let base: string
let link: (id: string) => string
let pictureLink: (id: string) => string

before(async () => {
  const { buildHttpApp, setVideoFileResolver, setPictureFileResolver } = await import('../src/http-app.js')
  const { getConfig } = await import('../src/auth.js')
  const { issueMediaLink, issuePictureLink } = await import('../src/video/media-links.js')
  setVideoFileResolver((id) => (id === ID ? videoPath : null))
  setPictureFileResolver((id) => (id === PICTURE_ID ? { path: picturePath, mime: 'image/png' } : null))
  link = (id) => issueMediaLink(getConfig().sessionSecret, id)
  pictureLink = (id) => issuePictureLink(getConfig().sessionSecret, id)
  server = buildHttpApp(null).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => new Promise<void>((r) => server.close(() => r())))

test('a signed link plays the video with safe headers', async () => {
  const res = await fetch(base + link(ID))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await res.arrayBuffer()).byteLength, 100)
})

test('seeking works (Range requests)', async () => {
  const res = await fetch(base + link(ID), { headers: { range: 'bytes=10-19' } })
  assert.equal(res.status, 206)
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '0123456789')
})

test('no signature, a wrong signature or another id gets nothing', async () => {
  assert.equal((await fetch(`${base}/media/video/${ID}`)).status, 404)
  const good = link(ID)
  assert.equal((await fetch(base + good.replace(/s=[0-9a-f]{4}/, 's=0000'))).status, 404)
  const other = 'f'.repeat(32)
  assert.equal((await fetch(base + link(other))).status, 404, 'a signed link for a video that does not exist')
  assert.equal((await fetch(`${base}/media/video/..%2F..%2Fetc%2Fpasswd?${new URL(good, base).search.slice(1)}`)).status, 404)
})

test('the Host check still applies to video links', async () => {
  const http = await import('node:http')
  const status = await new Promise<number>((resolve) => {
    const url = new URL(base + link(ID))
    http.get({ host: '127.0.0.1', port: url.port, path: url.pathname + url.search, headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode!))
  })
  assert.equal(status, 403)
})

test('a film picture has its own route and link kind: a picture link never opens a video, nor the reverse', async () => {
  const res = await fetch(base + pictureLink(PICTURE_ID))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'not really a png')
  const asVideo = new URL(base + pictureLink(PICTURE_ID))
  assert.equal((await fetch(`${base}/media/video/${PICTURE_ID}${asVideo.search}`)).status, 404)
  const asPicture = new URL(base + link(ID))
  assert.equal((await fetch(`${base}/media/picture/${ID}${asPicture.search}`)).status, 404)
  assert.equal((await fetch(base + pictureLink('e'.repeat(32)))).status, 404, 'a signed link for a picture no film uses')
})
