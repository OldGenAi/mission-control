// Pictures uploaded for image-to-video. Each one is checked before it is kept: it must really be
// a PNG, JPEG or WebP (by its first bytes, not its name), a single still frame, and a sensible
// size. It's stored under a random id the gateway picks, so a file name from the page can never
// reach the disk or ComfyUI.
//
// Security-sensitive. Do not modify without Claude review.

import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { stripPng } from './png-strip.js'

export type ImageType = 'png' | 'jpeg' | 'webp'

export interface ImageInfo { type: ImageType; width: number; height: number }

export const MAX_IMAGE_BYTES = 11 * 1024 * 1024 // base64 of this still fits the 16 MB WebSocket message cap
export const MIN_SIDE = 64
const MAX_SIDE = 8192

const MIME: Record<ImageType, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }
const EXT: Record<ImageType, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }

function pngInfo(buf: Buffer): ImageInfo | string {
  if (buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') return 'the PNG file is damaged'
  // An animated PNG declares acTL before its first image data. ComfyUI would load every frame.
  for (let at = 8; at + 8 <= buf.length;) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    if (type === 'acTL') return 'animated PNGs are not supported, use a still picture'
    if (type === 'IDAT' || type === 'IEND') break
    at += 12 + length
  }
  return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function jpegInfo(buf: Buffer): ImageInfo | string {
  for (let at = 2; at + 9 <= buf.length;) {
    if (buf[at] !== 0xff) return 'the JPEG file is damaged'
    const marker = buf[at + 1]!
    if (marker === 0xff) { at += 1; continue } // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue }
    const length = buf.readUInt16BE(at + 2)
    // Start-of-frame markers carry the size; C4 (Huffman), C8 and CC (arithmetic) don't.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: 'jpeg', height: buf.readUInt16BE(at + 5), width: buf.readUInt16BE(at + 7) }
    }
    if (marker === 0xd9 || marker === 0xda || length < 2) break
    at += 2 + length
  }
  return 'the JPEG file has no picture size'
}

function webpInfo(buf: Buffer): ImageInfo | string {
  if (buf.length < 30) return 'the WebP file is damaged'
  const chunk = buf.toString('latin1', 12, 16)
  if (chunk === 'VP8 ') return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const [b0, b1, b2, b3] = [buf[21]!, buf[22]!, buf[23]!, buf[24]!]
    return { type: 'webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
  }
  if (chunk === 'VP8X') {
    if (buf[20]! & 0x02) return 'animated WebP pictures are not supported, use a still picture'
    return { type: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  return 'the WebP file is damaged'
}

/** What the picture is and its size, judged by its contents, or why it isn't a picture we read. */
export function readImageInfo(buf: Buffer): ImageInfo | string {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return pngInfo(buf)
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return jpegInfo(buf)
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return webpInfo(buf)
  return 'the file is not a PNG, JPEG or WebP picture'
}

/** What the picture is, or why it can't be used as a video's picture (too small for the model, too large to handle). */
export function inspectImage(buf: Buffer): ImageInfo | string {
  const info = readImageInfo(buf)
  if (typeof info === 'string') return info
  if (info.width < MIN_SIDE || info.height < MIN_SIDE) return `the picture is too small (at least ${MIN_SIDE} pixels on each side)`
  if (info.width > MAX_SIDE || info.height > MAX_SIDE) return `the picture is too large (at most ${MAX_SIDE} pixels on each side)`
  return info
}

export interface StoredImage { id: string; path: string; fileName: string; mime: string }

export class ImageInputs {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  /** Checks and keeps a picture sent as base64. Returns its id and size, or why it was refused. */
  save(base64: unknown): (ImageInfo & { id: string }) | string {
    if (typeof base64 !== 'string' || base64.length === 0) return 'no picture was sent'
    // Plain base64 only: the length check bounds memory before decoding.
    if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return `the picture is larger than ${MAX_IMAGE_BYTES / 1024 ** 2} MB`
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return 'the picture data is not valid'
    const buf = Buffer.from(base64, 'base64')
    if (buf.length > MAX_IMAGE_BYTES) return `the picture is larger than ${MAX_IMAGE_BYTES / 1024 ** 2} MB`
    const info = inspectImage(buf)
    if (typeof info === 'string') return info
    const id = randomBytes(16).toString('hex')
    writeFileSync(join(this.dir, `${id}.${EXT[info.type]}`), buf, { mode: 0o600 })
    return { id, ...info }
  }

  /**
   * Keeps a picture Mission Control made itself (a ComfyUI picture job, a reference sheet): PNG only, stripped first.
   * A picture made from another one (a character cut out) can be kept under an id given for it; if a picture is
   * already kept under that id, that one stays.
   */
  saveBuffer(buf: Buffer, givenId?: string): (ImageInfo & { id: string }) | string {
    if (givenId !== undefined && !/^[0-9a-f]{32}$/.test(givenId)) return 'the picture id is not valid'
    if (buf.length > MAX_IMAGE_BYTES) return `the picture is larger than ${MAX_IMAGE_BYTES / 1024 ** 2} MB`
    const kind = readImageInfo(buf)
    if (typeof kind === 'string' || kind.type !== 'png') return 'the picture is not a PNG'
    const clean = stripPng(buf)
    if (!clean) return 'the PNG file is damaged'
    const info = inspectImage(clean)
    if (typeof info === 'string') return info
    const id = givenId ?? randomBytes(16).toString('hex')
    if (givenId === undefined) {
      writeFileSync(join(this.dir, `${id}.png`), clean, { mode: 0o600, flag: 'wx' })
      return { id, ...info }
    }
    // Whole or not at all: a given id is trusted once a file is there, so it is written under a temp name (the start-up
    // sweep's kind) and linked into place, which also never replaces one already there.
    const temp = join(this.dir, `tmp-${randomBytes(16).toString('hex')}.png`)
    writeFileSync(temp, clean, { mode: 0o600, flag: 'wx' })
    try {
      linkSync(temp, join(this.dir, `${id}.png`))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    } finally {
      rmSync(temp, { force: true })
    }
    return { id, ...info }
  }

  /** A copy of a stored picture under a new id, for a picture passed to a new owner (a film's copy of a cast picture). */
  copy(id: unknown): string | null {
    const stored = this.find(id)
    if (!stored) return null
    const copy = randomBytes(16).toString('hex')
    writeFileSync(join(this.dir, `${copy}${extname(stored.fileName)}`), readFileSync(stored.path), { mode: 0o600, flag: 'wx' })
    return copy
  }

  remove(id: unknown): void {
    const stored = this.find(id)
    if (stored) rmSync(stored.path, { force: true })
  }

  /** The stored picture with this id, or null. The id is checked before it touches a path. */
  find(id: unknown): StoredImage | null {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null
    for (const type of Object.keys(EXT) as ImageType[]) {
      const fileName = `${id}.${EXT[type]}`
      const path = join(this.dir, fileName)
      if (existsSync(path)) return { id, path, fileName, mime: MIME[type] }
    }
    return null
  }

  diskUsage(): number {
    let total = 0
    for (const name of readdirSync(this.dir)) {
      if (/^[0-9a-f]{32}\.(png|jpg|webp)$/.test(name)) total += statSync(join(this.dir, name)).size
    }
    return total
  }
}
