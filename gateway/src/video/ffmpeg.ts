// ffmpeg for the Storyboard: joining a film's shots and laying out reference sheets (storyboard spec 6.2 and 15).
// The Editor page will build on the same pieces.
//
// Security-sensitive. Do not modify without Claude review.
//
// - Found once on the PATH as a real program in an absolute folder (on Windows only a real .exe: Node's .bat and .cmd
//   spawning has had injection bugs even without a shell). Started without a shell, with an argument array.
// - Only gateway ids (32 hex digits, made into paths here) and checked whole numbers go into a command. Every input is
//   pinned to the file protocol, a format and its decoders, because those options apply only to the next input; there
//   are no generated (lavfi) inputs. Inputs must be regular files Mission Control made, never links.
// - The filter graph goes in a file the gateway writes, and may hold only allowed filters with no file options.
// - Outputs go to a temp name and are renamed into place only after ffprobe confirms them. Time and size limits, a
//   thread cap and a lower priority; Stop kills the process.

import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants as osConstants, setPriority } from 'node:os'
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ID = /^[0-9a-f]{32}$/
const FPS = 24
const WIDTH = 1280
const HEIGHT = 704
const MAX_CLIPS = 30
const MAX_CLIP_FRAMES = 10 * FPS + 1
const TRANSITION_FRAMES = new Set([0, 12, 24])
const MAX_FILM_BYTES = 1024 ** 3
const MAX_STDERR = 64 * 1024
const MAX_PROBE_OUTPUT = 256 * 1024
const THREADS = 4
const ALLOWED_FILTERS = new Set(['trim', 'atrim', 'setpts', 'asetpts', 'scale', 'crop', 'pad', 'fps', 'settb', 'setsar', 'format',
  'aresample', 'aformat', 'apad', 'anullsrc', 'color', 'overlay', 'concat', 'xfade', 'acrossfade', 'fade', 'afade'])

export interface FfmpegTools { ffmpeg: string; ffprobe: string; version: string }

/** A refusal or failure with plain words for the page. */
export class FfmpegError extends Error {}

export interface JoinClip {
  videoId: string
  inFrame: number
  outFrame: number
  transition: 'cut' | 'crossfade'
  transitionFrames: 0 | 12 | 24
}

/** A film's join, in whole frames at 24 fps: the shape the Editor will open too. */
export interface JoinPlan { clips: JoinClip[]; sound: boolean; fadeOutFrames: 0 | 12 | 24 }

export interface RunOptions { timeoutMs: number; signal?: AbortSignal; cwd?: string }

/** ffmpeg and ffprobe from the first absolute PATH folder that has both as real programs, or null. */
export function findFfmpeg(pathEnv = process.env['PATH'] ?? '', platform = process.platform): FfmpegTools | null {
  const exe = platform === 'win32' ? '.exe' : ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const ffmpeg = realFile(join(dir, `ffmpeg${exe}`))
    const ffprobe = realFile(join(dir, `ffprobe${exe}`))
    if (!ffmpeg || !ffprobe) continue
    let banner: string
    try {
      banner = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: MAX_PROBE_OUTPUT })
    } catch {
      continue
    }
    const version = /^ffmpeg version (\S+)/.exec(banner)?.[1]
    if (version) return { ffmpeg, ffprobe, version }
  }
  return null
}

function realFile(path: string): string | null {
  try {
    const real = realpathSync(path)
    return statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

/** Why a filter graph isn't one the gateway would make, or null when every filter is allowed and none names a file. */
export function checkFilterGraph(graph: string): string | null {
  for (const chain of graph.split(';')) {
    for (const part of chain.split(',')) {
      const body = part.trim().replace(/^(\[[A-Za-z0-9_:]+\])+/, '').replace(/(\[[A-Za-z0-9_:]+\])+$/, '')
      const eq = body.indexOf('=')
      const name = eq < 0 ? body : body.slice(0, eq)
      if (!ALLOWED_FILTERS.has(name)) return `filter not allowed: ${name || '(none)'}`
      if (eq >= 0 && body.slice(eq + 1).split(':').some((option) => /file/i.test(option.split('=')[0]!))) return `file option in ${name}`
    }
  }
  return null
}

// Seconds for ffmpeg from whole frames, to the microsecond.
function seconds(frames: number): string {
  return String(Number((frames / FPS).toFixed(6)))
}

function wholeFrames(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}

function checkPlan(plan: JoinPlan, hasAudio: readonly boolean[]): void {
  if (!Array.isArray(plan.clips) || plan.clips.length === 0) throw new FfmpegError('The film has no shots to join.')
  if (plan.clips.length > MAX_CLIPS) throw new FfmpegError(`A film can join at most ${MAX_CLIPS} shots.`)
  if (hasAudio.length !== plan.clips.length) throw new FfmpegError('Every shot needs its sound checked first.')
  if (!TRANSITION_FRAMES.has(plan.fadeOutFrames)) throw new FfmpegError('The fade at the end must be 0, half a second or a second.')
  plan.clips.forEach((clip, i) => {
    if (!ID.test(clip.videoId)) throw new FfmpegError('A shot in this film is not one Mission Control made.')
    if (!wholeFrames(clip.inFrame, 0, MAX_CLIP_FRAMES - 1) || !wholeFrames(clip.outFrame, clip.inFrame + 1, MAX_CLIP_FRAMES)) {
      throw new FfmpegError(`Shot ${i + 1} has frames out of order.`)
    }
    if (!TRANSITION_FRAMES.has(clip.transitionFrames) || (clip.transition === 'cut') !== (clip.transitionFrames === 0)) {
      throw new FfmpegError(`Shot ${i + 1} has a fade that isn't half a second or a second.`)
    }
    if (i === 0 && clip.transition !== 'cut') throw new FfmpegError('The first shot can\'t fade in from another one.')
    const before = plan.clips[i - 1]
    const length = clip.outFrame - clip.inFrame
    if (before && clip.transitionFrames * 2 > Math.min(length, before.outFrame - before.inFrame)) {
      throw new FfmpegError(`The fade into shot ${i + 1} is longer than half a shot.`)
    }
  })
}

/**
 * The ffmpeg arguments and filter graph for a join. Clips are found in mediaDir by id; hasAudio says, per clip,
 * whether ffprobe found sound (a clip without gets silence of the right length, or the join breaks).
 */
export function joinCommand(mediaDir: string, plan: JoinPlan, hasAudio: readonly boolean[], files = { filter: 'FILTER', output: 'OUTPUT' }): { args: string[]; filter: string; frames: number } {
  checkPlan(plan, hasAudio)
  const inputs: string[] = []
  const chains: string[] = []
  plan.clips.forEach((clip, i) => {
    inputs.push('-protocol_whitelist', 'file', '-f', 'mov', '-c:v', 'h264', '-c:a', 'aac', '-i', `file:${join(mediaDir, `${clip.videoId}.mp4`)}`)
    chains.push(`[${i}:v]trim=start_frame=${clip.inFrame}:end_frame=${clip.outFrame},setpts=PTS-STARTPTS,scale=${WIDTH}:-2:flags=lanczos,` +
      `crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},settb=1/${FPS},format=yuv420p[v${i}]`)
    if (!plan.sound) return
    const length = seconds(clip.outFrame - clip.inFrame)
    chains.push(hasAudio[i]
      ? `[${i}:a]atrim=start=${seconds(clip.inFrame)}:end=${seconds(clip.outFrame)},asetpts=PTS-STARTPTS,aresample=48000,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${length},atrim=duration=${length}[a${i}]`
      : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${length},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`)
  })

  // Shots join one at a time onto the film so far; a crossfade overlaps the two by its length.
  let video = 'v0'
  let audio = 'a0'
  let frames = plan.clips[0]!.outFrame - plan.clips[0]!.inFrame
  plan.clips.slice(1).forEach((clip, k) => {
    const i = k + 1
    const length = clip.outFrame - clip.inFrame
    if (clip.transition === 'cut') {
      chains.push(plan.sound
        ? `[${video}][${audio}][v${i}][a${i}]concat=n=2:v=1:a=1[jv${i}][ja${i}]`
        : `[${video}][v${i}]concat=n=2:v=1:a=0[jv${i}]`)
      frames += length
    } else {
      const fade = seconds(clip.transitionFrames)
      chains.push(`[${video}][v${i}]xfade=transition=fade:duration=${fade}:offset=${seconds(frames - clip.transitionFrames)}[jv${i}]`)
      if (plan.sound) chains.push(`[${audio}][a${i}]acrossfade=d=${fade}[ja${i}]`)
      frames += length - clip.transitionFrames
    }
    video = `jv${i}`
    audio = `ja${i}`
  })
  const fadeAt = seconds(frames - plan.fadeOutFrames)
  const fadeFor = seconds(plan.fadeOutFrames)
  chains.push(plan.fadeOutFrames > 0 ? `[${video}]fade=t=out:st=${fadeAt}:d=${fadeFor}[vout]` : `[${video}]format=yuv420p[vout]`)
  if (plan.sound) {
    chains.push(plan.fadeOutFrames > 0 ? `[${audio}]afade=t=out:st=${fadeAt}:d=${fadeFor}[aout]` : `[${audio}]aformat=sample_fmts=fltp[aout]`)
  }
  const filter = chains.join(';')

  const args = [
    '-nostdin', '-hide_banner', '-v', 'error', '-timelimit', '900',
    ...inputs,
    '-/filter_complex', files.filter,
    '-map', '[vout]', ...(plan.sound ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-threads', String(THREADS), '-fs', String(MAX_FILM_BYTES),
    '-f', 'mp4', '-y', files.output,
  ]
  return { args, filter, frames }
}

/** Runs ffmpeg with these arguments. Rejects with plain words when it fails, takes too long or is stopped. */
export function runFfmpeg(tools: FfmpegTools, args: string[], options: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new FfmpegError('ffmpeg was stopped.'))
    const child = spawn(tools.ffmpeg, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, cwd: options.cwd })
    try { if (child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL) } catch { /* best effort */ }
    let stderr = ''
    let outcome: FfmpegError | null = null
    const stop = (why: FfmpegError) => { outcome ??= why; child.kill('SIGKILL') }
    const timer = setTimeout(() => stop(new FfmpegError('ffmpeg took too long, so it was stopped.')), options.timeoutMs)
    const onAbort = () => stop(new FfmpegError('ffmpeg was stopped.'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8').slice(0, MAX_STDERR - stderr.length) })
    child.on('error', () => { outcome ??= new FfmpegError('ffmpeg could not be started.') })
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (outcome) return reject(outcome)
      if (code !== 0) {
        // The detail stays in the gateway's log: it can hold file paths.
        console.error('[ffmpeg] failed:', stderr.trim().slice(-2000))
        return reject(new FfmpegError('ffmpeg could not finish this.'))
      }
      resolve()
    })
  })
}

interface Probe { video: string | null; audio: string | null; frames: number; width: number; height: number }

async function probe(tools: FfmpegTools, path: string, format: 'mov' | 'png_pipe', signal?: AbortSignal): Promise<Probe> {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-f', format,
    '-show_entries', 'stream=codec_type,codec_name,width,height,nb_frames', '-of', 'json', `file:${path}`],
  { timeout: 30_000, maxBuffer: MAX_PROBE_OUTPUT, windowsHide: true, encoding: 'utf8', ...(signal ? { signal } : {}) })
  const streams = (JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> }).streams ?? []
  const video = streams.find((s) => s['codec_type'] === 'video')
  const audio = streams.find((s) => s['codec_type'] === 'audio')
  return {
    video: typeof video?.['codec_name'] === 'string' ? video['codec_name'] : null,
    audio: typeof audio?.['codec_name'] === 'string' ? audio['codec_name'] : null,
    frames: Number(video?.['nb_frames'] ?? 0),
    width: Number(video?.['width'] ?? 0),
    height: Number(video?.['height'] ?? 0),
  }
}

// A regular file in folder, named by a gateway id; never a link.
function ownFile(folder: string, id: string, ext: string, missing: string): string {
  if (!ID.test(id)) throw new FfmpegError(missing)
  const path = join(folder, `${id}.${ext}`)
  try {
    if (lstatSync(path).isFile()) return path
  } catch { /* missing */ }
  throw new FfmpegError(missing)
}

function tempName(folder: string, ext: string): string {
  return join(folder, `tmp-${randomBytes(16).toString('hex')}.${ext}`)
}

/** Joins a film's shots into mediaDir/<outId>.mp4. Every clip is checked first; the result is checked before it is kept. */
export async function joinFilm(tools: FfmpegTools, mediaDir: string, plan: JoinPlan, outId: string, options: RunOptions): Promise<{ frames: number; bytes: number }> {
  if (!ID.test(outId)) throw new FfmpegError('The film needs a Mission Control id.')
  const hasAudio: boolean[] = []
  for (const clip of plan.clips ?? []) {
    const path = ownFile(mediaDir, clip.videoId, 'mp4', 'A shot for this film is missing. Make it again.')
    let found: Probe
    try { found = await probe(tools, path, 'mov', options.signal) } catch { throw new FfmpegError('A shot for this film could not be read.') }
    if (found.video !== 'h264' || (found.audio !== null && found.audio !== 'aac')) throw new FfmpegError('A shot for this film is not the kind of video Mission Control makes.')
    if (clip.outFrame > found.frames) throw new FfmpegError('A shot for this film is shorter than the plan says.')
    hasAudio.push(found.audio === 'aac')
  }
  const filterPath = tempName(mediaDir, 'filter')
  const outPath = tempName(mediaDir, 'mp4')
  const { args, filter, frames } = joinCommand(mediaDir, plan, hasAudio, { filter: filterPath, output: outPath })
  const problem = checkFilterGraph(filter)
  if (problem) throw new FfmpegError(`Mission Control made a join it doesn't allow (${problem}).`)
  try {
    writeFileSync(filterPath, filter, { flag: 'wx', mode: 0o600 })
    await runFfmpeg(tools, args, options)
    const made = await probe(tools, outPath, 'mov', options.signal)
    if (made.video !== 'h264' || made.width !== WIDTH || made.height !== HEIGHT || Math.abs(made.frames - frames) > 1) {
      throw new FfmpegError('The joined film did not come out as planned.')
    }
    const bytes = statSync(outPath).size
    renameSync(outPath, join(mediaDir, `${outId}.mp4`))
    return { frames, bytes }
  } finally {
    rmSync(filterPath, { force: true })
    rmSync(outPath, { force: true })
  }
}

export interface SheetPictures { place: string; turnaround: string; face: string; prop?: string | undefined; placeWithCast: string }

// The red door sheet layout (local-video film90 sheets.py): x, y, width, height, and whether the picture fits inside
// its box (the wide turnaround) or fills it. Boxes keep a 6-pixel dark gap.
const GAP = 6
const LAYOUT = {
  place: [0, 0, 560, 352, false],
  turnaround: [560, 0, 720, 352, true],
  face: [0, 352, 350, 352, false],
  prop: [350, 352, 352, 352, true],
  placeWithCast: [702, 352, 578, 352, false],
  placeWithCastWide: [350, 352, 930, 352, false],
} as const

/** The Ingredients reference sheet, 1280x704, from pictures in inputsDir by id. Returns the PNG for saveBuffer. */
export async function makeSheet(tools: FfmpegTools, inputsDir: string, pictures: SheetPictures, options: RunOptions): Promise<Buffer> {
  const panels: Array<[string, readonly [number, number, number, number, boolean]]> = [
    [pictures.place, LAYOUT.place], [pictures.turnaround, LAYOUT.turnaround], [pictures.face, LAYOUT.face],
    ...(pictures.prop ? [[pictures.prop, LAYOUT.prop] as [string, typeof LAYOUT.prop]] : []),
    [pictures.placeWithCast, pictures.prop ? LAYOUT.placeWithCast : LAYOUT.placeWithCastWide],
  ]
  const inputs: string[] = []
  const chains = [`color=c=0x0c0c0c:s=${WIDTH}x${HEIGHT}:d=1[bg0]`]
  panels.forEach(([id, [x, y, w, h, fit]], i) => {
    inputs.push('-protocol_whitelist', 'file', '-f', 'png_pipe', '-c:v', 'png', '-i', `file:${ownFile(inputsDir, id, 'png', 'A picture for the sheet is missing.')}`)
    const bw = w - GAP
    const bh = h - GAP
    chains.push(fit
      ? `[${i}:v]scale=${bw}:${bh}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[p${i}]`
      : `[${i}:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=lanczos,crop=${bw}:${bh},setsar=1[p${i}]`)
    const at = `x=${x + GAP / 2}+(${bw}-overlay_w)/2:y=${y + GAP / 2}+(${bh}-overlay_h)/2`
    chains.push(`[bg${i}][p${i}]overlay=${at}[bg${i + 1}]`)
  })
  const filter = chains.join(';')
  const problem = checkFilterGraph(filter)
  if (problem) throw new FfmpegError(`Mission Control made a sheet it doesn't allow (${problem}).`)
  const filterPath = tempName(inputsDir, 'filter')
  const outPath = tempName(inputsDir, 'png')
  try {
    writeFileSync(filterPath, filter, { flag: 'wx', mode: 0o600 })
    await runFfmpeg(tools, ['-nostdin', '-hide_banner', '-v', 'error', ...inputs, '-/filter_complex', filterPath,
      '-map', `[bg${panels.length}]`, '-frames:v', '1', '-map_metadata', '-1', '-fflags', '+bitexact', '-threads', String(THREADS),
      '-f', 'image2', '-c:v', 'png', '-y', outPath], options)
    return readFileSync(outPath)
  } finally {
    rmSync(filterPath, { force: true })
    rmSync(outPath, { force: true })
  }
}
