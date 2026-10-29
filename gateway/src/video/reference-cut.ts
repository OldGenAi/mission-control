// A character's picture 2 for the pose edits: the character on its own, cut tight (hand test T10). Given a picture the
// same size and shape as the scene, the picture editor pasted the character in where it stood in its own picture and
// also drew it in the pose, so the live test's end pictures had two Toms and three dogs. Cut down to the character,
// it is drawn once.
//
// Only a character on a plain background is cut: the background is the colour all round the edge, the character is
// everything that differs from it. A busy background (a street photo) is reported, not guessed at.

import { createHash } from 'node:crypto'
import { dirname, extname } from 'node:path'
import { FfmpegError, pictureAsPng, type FfmpegTools, type PictureKind, type RunOptions } from './ffmpeg.js'
import { MIN_SIDE, type ImageInputs } from './image-input.js'
import { readRgbPng, rgbPng } from './png-strip.js'

export interface CharacterBox { x: number; y: number; width: number; height: number }

// The edge band looked at for the background, as a share of each side.
const EDGE = 0.03
// How much of the edge band must be the background's colour (a character may touch an edge), and how near counts.
const PLAIN_SHARE = 0.75
const NEAR = 24
// How far from the background a pixel must be to be part of the character (the three colours added up).
const APART = 60
// A row or column is part of the character only with at least this share of such pixels (2 at least): specks don't count.
const MIN_SHARE = 0.005
// Room left round the character, as a share of its longer side.
const MARGIN = 0.12

/** Where the character is in a picture (8-bit RGB pixels), or why it can't be cut: a busy background, or nobody in it. */
export function findCharacter(rgb: Buffer, width: number, height: number): CharacterBox | 'busy' | 'empty' {
  const ew = Math.max(1, Math.round(width * EDGE))
  const eh = Math.max(1, Math.round(height * EDGE))
  const alongEdge = (visit: (at: number) => void) => {
    for (let y = 0; y < height; y++) {
      const band = y < eh || y >= height - eh
      for (let x = 0; x < width; x++) if (band || x < ew || x >= width - ew) visit((y * width + x) * 3)
    }
  }
  // The background is the edge band's middle colour, each of the three on its own.
  const counts = [0, 1, 2].map(() => new Array<number>(256).fill(0))
  let edge = 0
  alongEdge((at) => { edge++; for (let c = 0; c < 3; c++) counts[c]![rgb[at + c]!]!++ })
  const background = counts.map((count) => middle(count, edge))
  let near = 0
  alongEdge((at) => { if ([0, 1, 2].every((c) => Math.abs(rgb[at + c]! - background[c]!) <= NEAR)) near++ })
  if (near < edge * PLAIN_SHARE) return 'busy'

  const rows = new Array<number>(height).fill(0)
  const columns = new Array<number>(width).fill(0)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3
      const apart = Math.abs(rgb[at]! - background[0]!) + Math.abs(rgb[at + 1]! - background[1]!) + Math.abs(rgb[at + 2]! - background[2]!)
      if (apart > APART) { rows[y]!++; columns[x]!++ }
    }
  }
  const span = (counts: number[], across: number) => {
    const least = Math.max(2, Math.ceil(across * MIN_SHARE))
    const first = counts.findIndex((n) => n >= least)
    if (first < 0) return null
    let last = counts.length - 1
    while (counts[last]! < least) last--
    return [first, last] as const
  }
  const ys = span(rows, width)
  const xs = span(columns, height)
  if (!ys || !xs) return 'empty'
  const margin = Math.round(MARGIN * Math.max(xs[1] - xs[0] + 1, ys[1] - ys[0] + 1))
  const x = Math.max(0, xs[0] - margin)
  const y = Math.max(0, ys[0] - margin)
  return { x, y, width: Math.min(width - 1, xs[1] + margin) - x + 1, height: Math.min(height - 1, ys[1] + margin) - y + 1 }
}

// The middle value of `total` values counted by value.
function middle(counts: number[], total: number): number {
  let seen = 0
  for (let v = 0; v < 256; v++) {
    seen += counts[v]!
    if (seen * 2 >= total) return v
  }
  return 255
}

// The box grown evenly to at least `side` each way, staying inside the picture.
function atLeast(box: CharacterBox, side: number, width: number, height: number): CharacterBox {
  const grow = (start: number, length: number, limit: number) => {
    const wanted = Math.min(Math.max(length, side), limit)
    const from = Math.min(Math.max(0, start - Math.floor((wanted - length) / 2)), limit - wanted)
    return [from, wanted] as const
  }
  const [x, w] = grow(box.x, box.width, width)
  const [y, h] = grow(box.y, box.height, height)
  return { x, y, width: w, height: h }
}

/** The id the cut-out of a picture is kept under: from the picture's own id, so each picture is cut once. */
export function referenceIdFor(pictureId: string): string {
  return createHash('sha256').update(`mission-control character cut v1:${pictureId}`).digest('hex').slice(0, 32)
}

/**
 * The character in a kept picture, on its own and cut tight, kept as a picture of its own. 'busy' or 'empty' when the
 * picture can't be cut (findCharacter), 'missing' when there is no such picture.
 */
export async function cutReference(tools: FfmpegTools, images: ImageInputs, pictureId: string, options: RunOptions): Promise<{ id: string } | 'busy' | 'empty' | 'missing'> {
  const stored = images.find(pictureId)
  if (!stored) return 'missing'
  const id = referenceIdFor(pictureId)
  if (images.find(id)) return { id }
  const ext = extname(stored.fileName).slice(1) as PictureKind
  const picture = readRgbPng(await pictureAsPng(tools, dirname(stored.path), pictureId, ext, options))
  if (!picture) throw new FfmpegError('ffmpeg made a picture Mission Control could not read.')
  const found = findCharacter(picture.rgb, picture.width, picture.height)
  if (typeof found === 'string') return found
  const box = atLeast(found, MIN_SIDE, picture.width, picture.height)
  const cut = Buffer.alloc(box.width * box.height * 3)
  for (let row = 0; row < box.height; row++) {
    const from = ((box.y + row) * picture.width + box.x) * 3
    picture.rgb.copy(cut, row * box.width * 3, from, from + box.width * 3)
  }
  const saved = images.saveBuffer(rgbPng(box.width, box.height, cut), id)
  if (typeof saved === 'string') throw new FfmpegError(`The picture of the character on its own could not be kept (${saved}).`)
  return { id }
}
