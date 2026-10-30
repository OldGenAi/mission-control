// Run with: npm test
// A character's picture 2 is the character on its own, cut tight (hand test T10). With a picture the same size and
// shape as the scene, the picture editor pasted the character in where it stood in its own picture and drew it again
// in the pose: two Toms and three dogs in the live test's end pictures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { cutReference, findCharacter, referenceIdFor } from '../src/video/reference-cut.js'
import { SEE_THROUGH, readRgbPng, rgbPng, stripPng } from '../src/video/png-strip.js'
import { findFfmpeg } from '../src/video/ffmpeg.js'
import { ImageInputs } from '../src/video/image-input.js'

type Colour = [number, number, number]
const GREY: Colour = [205, 205, 205]

function pixels(width: number, height: number, paint: (x: number, y: number) => Colour): Buffer {
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(paint(x, y), (y * width + x) * 3)
  return rgb
}

// A plain grey picture with a dark figure standing in it, like Tom's: 30 wide and 130 tall at (250, 40).
const figure = (x: number, y: number) => x >= 250 && x < 280 && y >= 40 && y < 170
const standing = pixels(400, 200, (x, y) => figure(x, y) ? [90, 60, 30] : GREY)

test('a figure on a plain background is found, with a margin round it', () => {
  // The margin is 12% of the figure's longer side: 16 pixels.
  assert.deepEqual(findCharacter(standing, 400, 200), { x: 234, y: 24, width: 62, height: 162 })
})

test('the margin stops at the picture\'s edges', () => {
  const atEdge = pixels(400, 200, (x, y) => x < 30 && y >= 40 && y < 170 ? [90, 60, 30] : GREY)
  assert.deepEqual(findCharacter(atEdge, 400, 200), { x: 0, y: 24, width: 46, height: 162 })
})

test('soft noise in the background and odd specks don\'t stretch the box', () => {
  const noisy = pixels(400, 200, (x, y) => {
    if (figure(x, y)) return [90, 60, 30]
    if ((x === 60 && y === 100) || (x === 350 && y === 20)) return [0, 0, 0]
    const n = ((x * 7 + y * 13) % 13) - 6
    return [GREY[0] + n, GREY[1] + n, GREY[2] + n]
  })
  assert.deepEqual(findCharacter(noisy, 400, 200), { x: 234, y: 24, width: 62, height: 162 })
})

test('a busy background (a street photo) is not cut: it says so', () => {
  const street = pixels(400, 200, (x, y) => figure(x, y) ? [90, 60, 30] : [(x * 5) % 256, (y * 9) % 256, ((x + y) * 3) % 256])
  assert.equal(findCharacter(street, 400, 200), 'busy')
})

test('a plain picture with nobody in it says so', () => {
  assert.equal(findCharacter(pixels(400, 200, () => GREY), 400, 200), 'empty')
})

test('rgbPng makes a PNG that reads back pixel for pixel and holds nothing but the picture', () => {
  const png = rgbPng(400, 200, standing)
  assert.deepEqual(readRgbPng(png), { width: 400, height: 200, rgb: standing })
  assert.deepEqual(stripPng(png), png)
})

test('readRgbPng refuses what it wasn\'t made for: another colour type, an interlaced picture, data of the wrong size', () => {
  const png = rgbPng(4, 4, pixels(4, 4, () => GREY))
  const changed = (at: number, value: number) => {
    const copy = Buffer.from(png)
    copy[at] = value
    // The header's checksum has to match again, or it is refused for that alone.
    copy.writeUInt32BE(crc32(copy.subarray(12, 29)), 29)
    return copy
  }
  assert.equal(readRgbPng(changed(25, 4)), null, 'grey with alpha')
  assert.equal(readRgbPng(changed(24, 16)), null, '16 bits')
  assert.equal(readRgbPng(changed(28, 1)), null, 'interlaced')
  assert.equal(readRgbPng(changed(19, 5)), null, 'wider than its data')
  assert.equal(readRgbPng(Buffer.from('not a picture')), null)
})

// An 8-bit RGBA PNG (colour type 6) of these pixels, for see-through pictures.
// Every other row uses the Sub filter, as ffmpeg's encoder does use filters (review 6).
function rgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const stride = width * 4
  const rows = Buffer.alloc(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    const at = y * (1 + stride)
    if (y % 2 === 0) { rgba.copy(rows, at + 1, y * stride, (y + 1) * stride); continue }
    rows[at] = 1
    for (let i = 0; i < stride; i++) rows[at + 1 + i] = (rgba[y * stride + i]! - (i >= 4 ? rgba[y * stride + i - 4]! : 0)) & 0xff
  }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

test('a see-through picture reads as the character on light grey, whatever colours hide in the see-through part (review 5 S2)', () => {
  const rgba = Buffer.alloc(400 * 200 * 4)
  for (let y = 0; y < 200; y++) for (let x = 0; x < 400; x++) {
    // Leftover colours under the see-through part, as some editors keep them.
    rgba.set(figure(x, y) ? [90, 60, 30, 255] : [(x * 5) % 256, (y * 9) % 256, 40, 0], (y * 400 + x) * 4)
  }
  const read = readRgbPng(rgbaPng(400, 200, rgba))!
  assert.deepEqual([...read.rgb.subarray(0, 3)], [...SEE_THROUGH])
  const inFigure = ((101 * 400) + 260) * 3
  assert.deepEqual([...read.rgb.subarray(inFigure, inFigure + 3)], [90, 60, 30], 'a filtered row reads back right')
  assert.deepEqual(findCharacter(read.rgb, 400, 200), { x: 234, y: 24, width: 62, height: 162 })
})

test('the cut picture\'s id comes from the picture\'s own, so each picture is cut once', () => {
  const a = 'a'.repeat(32)
  assert.match(referenceIdFor(a), /^[0-9a-f]{32}$/)
  // Version 2: cut-outs made before pictures were made to fit and see-through parts read as grey are made again (review 6).
  assert.equal(referenceIdFor(a), createHash('sha256').update(`mission-control character cut v2:${a}`).digest('hex').slice(0, 32))
  assert.equal(referenceIdFor(a), referenceIdFor(a))
  assert.notEqual(referenceIdFor(a), a)
  assert.notEqual(referenceIdFor(a), referenceIdFor('b'.repeat(32)))
})

test('a picture kept under a given id: only a proper id, and a second save of the same id keeps the first', () => {
  const images = new ImageInputs(mkdtempSync(join(tmpdir(), 'mc-cut-ids-')))
  const png = rgbPng(400, 200, standing)
  assert.equal(images.saveBuffer(png, '../escape'), 'the picture id is not valid')
  const id = 'c'.repeat(32)
  const first = images.saveBuffer(png, id)
  assert.ok(typeof first !== 'string' && first.id === id)
  assert.ok(typeof images.saveBuffer(rgbPng(400, 200, pixels(400, 200, () => GREY)), id) !== 'string')
  assert.deepEqual(readFileSync(images.find(id)!.path), png, 'the first stays')
  // Kept whole or not at all: written under a temp name first, so a crash mid-write never leaves half a picture
  // under the id (review 5 S4); no temp file is left behind.
  assert.deepEqual(readdirSync(dirname(images.find(id)!.path)).filter((n) => n.startsWith('tmp-')), [])
})

test('a big picture is made smaller before it is cut, so the cut-out stays a size Mission Control keeps (review 5 S1)', { skip: findFfmpeg() ? false : 'no ffmpeg on this computer' }, async () => {
  const images = new ImageInputs(mkdtempSync(join(tmpdir(), 'mc-cut-big-')))
  // 4000x2000 with a figure 300 wide and 1300 tall: cut at full size it would be about 3.4 MB of pixels each way up.
  const big = images.saveBuffer(rgbPng(4000, 2000, pixels(4000, 2000, (x, y) => x >= 2500 && x < 2800 && y >= 400 && y < 1700 ? [90, 60, 30] : GREY)))
  assert.ok(typeof big !== 'string')
  const cut = await cutReference(findFfmpeg()!, images, big.id, { timeoutMs: 30_000 })
  assert.ok(typeof cut !== 'string')
  const read = readRgbPng(readFileSync(images.find(cut.id)!.path))!
  // Made to fit 1536 each way first (1536x768, a scale of 0.384): the figure is then about 115x499 plus the margin.
  assert.ok(read.height <= 1536 && read.height > 499 && read.height < 640, `height ${read.height}`)
})

const tools = findFfmpeg()

test('end to end with ffmpeg: the character cut out once, a busy picture refused', { skip: tools ? false : 'no ffmpeg on this computer' }, async () => {
  const images = new ImageInputs(mkdtempSync(join(tmpdir(), 'mc-cut-')))
  const saved = images.saveBuffer(rgbPng(400, 200, standing))
  assert.ok(typeof saved !== 'string')
  const cut = await cutReference(tools!, images, saved.id, { timeoutMs: 30_000 })
  assert.deepEqual(cut, { id: referenceIdFor(saved.id) })
  const stored = images.find(referenceIdFor(saved.id))!
  const read = readRgbPng(readFileSync(stored.path))!
  // The 62-wide box is grown evenly to 64, the smallest picture Mission Control keeps: it starts at (233, 24).
  assert.deepEqual([read.width, read.height], [64, 162])
  const at = ((90 - 24) * 64 + (255 - 233)) * 3
  assert.deepEqual([...read.rgb.subarray(at, at + 3)], [90, 60, 30], 'the figure is in it')
  assert.deepEqual([...read.rgb.subarray(0, 3)], GREY, 'with the background round it')
  const madeAt = statSync(stored.path).mtimeMs
  assert.deepEqual(await cutReference(tools!, images, saved.id, { timeoutMs: 30_000 }), cut)
  assert.equal(statSync(stored.path).mtimeMs, madeAt, 'cut once')

  const street = images.saveBuffer(rgbPng(400, 200, pixels(400, 200, (x, y) => [(x * 5) % 256, (y * 9) % 256, ((x + y) * 3) % 256])))
  assert.ok(typeof street !== 'string')
  assert.equal(await cutReference(tools!, images, street.id, { timeoutMs: 30_000 }), 'busy')
  assert.equal(await cutReference(tools!, images, 'd'.repeat(32), { timeoutMs: 30_000 }), 'missing')
})
