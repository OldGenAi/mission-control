// Run with: npm test
// ffmpeg for the Storyboard (storyboard spec 6.2 and 15): found once as a real program, run without a shell, every input
// pinned to a file and a format, only gateway ids and checked numbers in the command, only allowed filters in the graph.
// The real-ffmpeg tests make their own clips and are skipped when ffmpeg isn't installed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  checkFilterGraph, ffmpegMajor, findFfmpeg, joinCommand, joinFilm, makeSheet, runFfmpeg, stopLeftoverFfmpeg, supportsOptionFiles, FfmpegError, type JoinPlan,
} from '../src/video/ffmpeg.js'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const unix = process.platform !== 'win32'
const tools = findFfmpeg()

function plan(overrides: Partial<JoinPlan> = {}): JoinPlan {
  return {
    clips: [
      { videoId: A, inFrame: 0, outFrame: 97, transition: 'cut', transitionFrames: 0 },
      { videoId: B, inFrame: 1, outFrame: 97, transition: 'cut', transitionFrames: 0 },
    ],
    sound: true, fadeOutFrames: 24, ...overrides,
  }
}

test('ffmpeg is found only as a real program in an absolute PATH folder', { skip: !unix }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ff-path-'))
  for (const name of ['ffmpeg', 'ffprobe']) {
    writeFileSync(join(dir, name), '#!/bin/sh\necho "ffmpeg version 8.0.1-test Copyright (c) the FFmpeg developers"\n')
    chmodSync(join(dir, name), 0o755)
  }
  const found = findFfmpeg(['relative/bin', '.', '', dir].join(delimiter))
  // The real path: macOS's temp folder is a link into /private.
  assert.equal(found?.ffmpeg, realpathSync(join(dir, 'ffmpeg')))
  assert.equal(found?.version, '8.0.1-test')
  assert.equal(findFfmpeg(['.', 'relative'].join(delimiter)), null, 'relative folders are skipped')
  assert.equal(findFfmpeg(mkdtempSync(join(tmpdir(), 'mc-ff-empty-'))), null)
})

test('every input is pinned to a file, a format and its decoders, and named by its id only', () => {
  const dir = '/media'
  const { args } = joinCommand(dir, plan(), [true, false])
  const inputs = args.flatMap((a, i) => (a === '-i' ? [i] : []))
  assert.equal(inputs.length, 2)
  for (const at of inputs) {
    assert.deepEqual(args.slice(at - 8, at), ['-protocol_whitelist', 'file', '-f', 'mov', '-c:v', 'h264', '-c:a', 'aac'])
    // The folder's own separator: backslashes on Windows.
    const folder = join(dir, 'x').slice(0, -1)
    assert.match(args[at + 1]!, new RegExp(`^file:${folder.replace(/\\/g, '\\\\')}[0-9a-f]{32}\\.mp4$`))
  }
  assert.ok(args.includes('-nostdin'))
  assert.equal(args.filter((a) => a === '-f').length, 3, 'mov for each input, and mp4 out')
  assert.ok(!args.some((a) => /lavfi/.test(a)), 'no generated inputs')
})

test('a plan with anything odd in it is refused before a command exists', () => {
  const bad: Array<[string, Partial<JoinPlan>]> = [
    ['an id that is a path', { clips: [{ videoId: '../../etc/passwd', inFrame: 0, outFrame: 10, transition: 'cut', transitionFrames: 0 }] }],
    ['frames backwards', { clips: [{ videoId: A, inFrame: 50, outFrame: 10, transition: 'cut', transitionFrames: 0 }] }],
    ['a fraction', { clips: [{ videoId: A, inFrame: 0.5, outFrame: 10, transition: 'cut', transitionFrames: 0 }] }],
    ['an odd fade', { clips: [plan().clips[0]!, { videoId: B, inFrame: 0, outFrame: 97, transition: 'crossfade', transitionFrames: 7 as 12 }] }],
    ['a fade longer than half a clip', { clips: [{ videoId: A, inFrame: 0, outFrame: 30, transition: 'cut', transitionFrames: 0 }, { videoId: B, inFrame: 0, outFrame: 97, transition: 'crossfade', transitionFrames: 24 }] }],
    ['a first clip that fades in', { clips: [{ videoId: A, inFrame: 0, outFrame: 97, transition: 'crossfade', transitionFrames: 12 }] }],
    ['no clips', { clips: [] }],
    ['too many clips', { clips: Array.from({ length: 31 }, () => plan().clips[0]!) }],
    ['an odd fade out', { fadeOutFrames: 5 as 12 }],
  ]
  for (const [why, overrides] of bad) assert.throws(() => joinCommand('/media', plan(overrides), [true, true]), FfmpegError, why)
})

test('crossfades overlap and are worked out in whole frames', () => {
  const crossed = plan({ clips: [plan().clips[0]!, { videoId: B, inFrame: 0, outFrame: 97, transition: 'crossfade', transitionFrames: 12 }] })
  const { filter, frames } = joinCommand('/media', crossed, [true, true])
  assert.equal(frames, 97 + 97 - 12)
  assert.match(filter, /xfade=transition=fade:duration=0\.5:offset=3\.541667/)
  assert.match(filter, /acrossfade=d=0\.5/)
  assert.equal(joinCommand('/media', plan(), [true, true]).frames, 97 + 96)
})

test('without sound there is no audio at all; a clip without sound gets silence', () => {
  const silent = joinCommand('/media', plan({ sound: false }), [true, true])
  assert.doesNotMatch(silent.filter, /atrim|anullsrc|acrossfade|afade/)
  assert.ok(silent.args.includes('-an'))
  const mixed = joinCommand('/media', plan(), [true, false])
  assert.match(mixed.filter, /anullsrc=channel_layout=stereo:sample_rate=48000/)
})

test('only allowed filters can be in a graph', () => {
  assert.equal(checkFilterGraph(joinCommand('/media', plan(), [true, true]).filter), null)
  for (const evil of ['movie=/etc/passwd[x]', '[0:v]subtitles=/home/x.srt[v]', 'amovie=a.wav', '[0:v]sendcmd=f=cmds.txt,scale=1:1[v]',
    '[0:v]drawtext=textfile=/etc/passwd[v]', '[0:v]lut3d=file=x.cube[v]', '[0:v]zmq[v]']) {
    assert.notEqual(checkFilterGraph(evil), null, evil)
  }
})

test('a run that takes too long is stopped, and so is one that is cancelled', { skip: !unix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ff-slow-'))
  writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nsleep 30\n'); chmodSync(join(dir, 'ffmpeg'), 0o755)
  const slow = { ffmpeg: join(dir, 'ffmpeg'), ffprobe: join(dir, 'ffmpeg'), version: 'test' }
  await assert.rejects(runFfmpeg(slow, [], { timeoutMs: 200 }), /took too long/)
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 100)
  await assert.rejects(runFfmpeg(slow, [], { timeoutMs: 10_000, signal: stop.signal }), /stopped/)
})

// Two clips like LTX's: 960x544, 24 fps, H.264, the first with AAC sound, the second silent.
function makeClips(media: string): void {
  const make = (id: string, sound: boolean) => execFileSync(tools!.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=960x544:r=24:d=4.0417',
    ...(sound ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=4.0417'] : []), '-frames:v', '97', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    ...(sound ? ['-c:a', 'aac', '-ac', '2'] : []), '-metadata', 'title=secret prompt', '-y', join(media, `${id}.mp4`)])
  make(A, true)
  make(B, false)
}

function streams(path: string): Array<Record<string, string>> {
  const out = execFileSync(tools!.ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,nb_read_frames:format_tags', '-of', 'json', path], { encoding: 'utf8' })
  return (JSON.parse(out) as { streams: Array<Record<string, string>> }).streams
}

test('a real join: a cut with the doubled frame dropped, 1280x704, sound padded, no metadata', { skip: !tools }, async () => {
  const media = mkdtempSync(join(tmpdir(), 'mc-ff-media-'))
  makeClips(media)
  const out = 'c'.repeat(32)
  const result = await joinFilm(tools!, media, plan(), out, { timeoutMs: 120_000 })
  assert.equal(result.frames, 193)
  const s = streams(join(media, `${out}.mp4`))
  const video = s.find((x) => x.codec_type === 'video')!
  assert.equal(`${video.width}x${video.height}`, '1280x704')
  assert.equal(Number(video.nb_read_frames), 193)
  assert.ok(s.some((x) => x.codec_type === 'audio'), 'sound kept, silence for the silent clip')
  assert.deepEqual(readdirSync(media).filter((n) => n.startsWith('tmp-')), [], 'temp files cleaned up')
  const tags = execFileSync(tools!.ffprobe, ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', join(media, `${out}.mp4`)], { encoding: 'utf8' })
  assert.doesNotMatch(tags, /secret prompt/)
})

test('a real join with a crossfade and no sound', { skip: !tools }, async () => {
  const media = mkdtempSync(join(tmpdir(), 'mc-ff-media-'))
  makeClips(media)
  const out = 'd'.repeat(32)
  const crossed = plan({ sound: false, clips: [plan().clips[0]!, { videoId: B, inFrame: 0, outFrame: 97, transition: 'crossfade', transitionFrames: 24 }] })
  await joinFilm(tools!, media, crossed, out, { timeoutMs: 120_000 })
  const s = streams(join(media, `${out}.mp4`))
  assert.equal(Number(s.find((x) => x.codec_type === 'video')!.nb_read_frames), 97 + 97 - 24)
  assert.equal(s.some((x) => x.codec_type === 'audio'), false)
})

test('a real join with a cut and then a crossfade (as a film goes from one place to the next)', { skip: !tools }, async () => {
  const media = mkdtempSync(join(tmpdir(), 'mc-ff-media-'))
  makeClips(media)
  const out = 'd'.repeat(32)
  const clips = [...plan().clips, { videoId: A, inFrame: 0, outFrame: 97, transition: 'crossfade' as const, transitionFrames: 12 as const }]
  for (const sound of [true, false]) {
    const result = await joinFilm(tools!, media, plan({ sound, clips }), out, { timeoutMs: 120_000 })
    assert.equal(result.frames, 97 + 96 + 97 - 12)
    assert.equal(Number(streams(join(media, `${out}.mp4`)).find((x) => x.codec_type === 'video')!.nb_read_frames), result.frames)
  }
})

test('a missing clip or a link instead of a file is refused', { skip: !tools || !unix }, async () => {
  const media = mkdtempSync(join(tmpdir(), 'mc-ff-media-'))
  makeClips(media)
  await assert.rejects(joinFilm(tools!, media, plan({ clips: [{ ...plan().clips[0]!, videoId: 'e'.repeat(32) }] }), 'c'.repeat(32), { timeoutMs: 60_000 }), /missing/)
  execFileSync('ln', ['-s', join(media, `${A}.mp4`), join(media, `${'f'.repeat(32)}.mp4`)])
  await assert.rejects(joinFilm(tools!, media, plan({ clips: [{ ...plan().clips[0]!, videoId: 'f'.repeat(32) }] }), 'c'.repeat(32), { timeoutMs: 60_000 }), /missing/)
})

test('a real reference sheet in the red door layout', { skip: !tools }, async () => {
  const inputs = mkdtempSync(join(tmpdir(), 'mc-ff-inputs-'))
  const ids = ['1', '2', '3', '4', '5'].map((d) => d.repeat(32))
  for (const id of ids) execFileSync(tools!.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=960x544', '-frames:v', '1', '-y', join(inputs, `${id}.png`)])
  const png = await makeSheet(tools!, inputs, { place: ids[0]!, turnaround: ids[1]!, face: ids[2]!, prop: ids[3]!, placeWithCast: ids[4]! }, { timeoutMs: 60_000 })
  assert.deepEqual(png.subarray(1, 4).toString('latin1'), 'PNG')
  assert.equal(png.readUInt32BE(16), 1280)
  assert.equal(png.readUInt32BE(20), 704)
  const noProp = await makeSheet(tools!, inputs, { place: ids[0]!, turnaround: ids[1]!, face: ids[2]!, placeWithCast: ids[4]! }, { timeoutMs: 60_000 })
  assert.equal(noProp.readUInt32BE(16), 1280)
  await assert.rejects(makeSheet(tools!, inputs, { place: '../../x', turnaround: ids[1]!, face: ids[2]!, placeWithCast: ids[4]! }, { timeoutMs: 60_000 }), FfmpegError)
})

test('the filter graph goes in a file only where ffmpeg can read option files (7.0 and newer); older ones get it inline', () => {
  for (const [version, yes] of [['8.0.1-3ubuntu2', true], ['7.1-full_build-www.gyan.dev', true], ['n7.0.2', true], ['N-118000-gdeadbeef', true],
    ['2025-01-20-git-1234-full_build-www.gyan.dev', true], ['2023-11-02-git-abcd-full_build-www.gyan.dev', false], ['2024-04-05-git-abcd', true],
    ['6.1.1-3ubuntu5', false], ['4.4.2-0ubuntu0.22.04.1', false], ['test', false]] as const) {
    assert.equal(supportsOptionFiles(version), yes, version)
  }
  assert.equal(ffmpegMajor('6.1.1-3ubuntu5'), 6)
  assert.equal(ffmpegMajor('N-118000-gdeadbeef'), null)
  const file = joinCommand('/media', plan(), [true, false], { filter: '/media/tmp-x.filter', output: '/media/tmp-y.mp4' })
  assert.deepEqual(file.args.slice(file.args.indexOf('-/filter_complex'), file.args.indexOf('-/filter_complex') + 2), ['-/filter_complex', '/media/tmp-x.filter'])
  const inline = joinCommand('/media', plan(), [true, false], { filter: '/media/tmp-x.filter', output: '/media/tmp-y.mp4' }, true)
  assert.ok(!inline.args.includes('-/filter_complex'))
  assert.equal(inline.args[inline.args.indexOf('-filter_complex') + 1], inline.filter)
})

// A stand-in ffmpeg that writes down how it was started, then fails.
function recordingFfmpeg(version: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ff-rec-'))
  writeFileSync(join(dir, 'ffmpeg'), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${dir}/args"\nexit 1\n`)
  chmodSync(join(dir, 'ffmpeg'), 0o755)
  return { tools: { ffmpeg: join(dir, 'ffmpeg'), ffprobe: join(dir, 'ffmpeg'), version }, args: () => readFileSync(join(dir, 'args'), 'utf8').trim().split('\n') }
}

test('the sheet run has its own size and time limits, and its filter inline for an older ffmpeg', { skip: !unix }, async () => {
  const inputs = mkdtempSync(join(tmpdir(), 'mc-ff-inputs-'))
  const ids = ['1', '2', '3', '4'].map((d) => d.repeat(32))
  for (const id of ids) writeFileSync(join(inputs, `${id}.png`), 'png')
  const pictures = { place: ids[0]!, turnaround: ids[1]!, face: ids[2]!, placeWithCast: ids[3]! }
  const fresh = recordingFfmpeg('8.0.1')
  await assert.rejects(makeSheet(fresh.tools, inputs, pictures, { timeoutMs: 10_000 }), /could not finish/)
  const args = fresh.args()
  assert.ok(args.includes('-fs') && Number(args[args.indexOf('-fs') + 1]) > 0)
  assert.ok(args.includes('-timelimit'))
  assert.match(args[args.indexOf('-/filter_complex') + 1]!, /tmp-[0-9a-f]{32}\.filter$/)
  const old = recordingFfmpeg('6.1.1-3ubuntu5')
  await assert.rejects(makeSheet(old.tools, inputs, pictures, { timeoutMs: 10_000 }), /could not finish/)
  assert.match(old.args()[old.args().indexOf('-filter_complex') + 1]!, /^color=c=0x0c0c0c/)
  assert.deepEqual(readdirSync(inputs).filter((n) => n.startsWith('tmp-')), [], 'no filter file left behind')
})

test('a leftover ffmpeg from before a crash is stopped, but only when its pid file names that very program', { skip: process.platform !== 'linux' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ff-pid-'))
  const pidFile = join(dir, 'ffmpeg.pid')
  const sleeper = { ffmpeg: realpathSync('/bin/sleep'), ffprobe: realpathSync('/bin/sleep'), version: 'test' }
  const running = runFfmpeg(sleeper, ['30'], { timeoutMs: 60_000, pidFile })
  await new Promise((r) => setTimeout(r, 200))
  const [pid, program] = readFileSync(pidFile, 'utf8').split('\n')
  assert.equal(program, sleeper.ffmpeg)
  stopLeftoverFfmpeg(pidFile, sleeper)
  await assert.rejects(running)
  assert.throws(() => process.kill(Number(pid), 0), 'the leftover is gone')
  assert.equal(existsSync(pidFile), false)
  // A pid file whose process is some other program (here, this test itself) leaves it alone.
  writeFileSync(pidFile, `${process.pid}\n${sleeper.ffmpeg}`)
  stopLeftoverFfmpeg(pidFile, sleeper)
  assert.equal(existsSync(pidFile), false)
})

test('a leftover is stopped only if that process started when the pid file was written, never a later one with the same number (second review N-S4)', { skip: process.platform !== 'linux' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ff-pid2-'))
  const pidFile = join(dir, 'ffmpeg.pid')
  const sleeper = { ffmpeg: realpathSync('/bin/sleep'), ffprobe: realpathSync('/bin/sleep'), version: 'test' }
  const later = runFfmpeg(sleeper, ['30'], { timeoutMs: 60_000 })
  await new Promise((r) => setTimeout(r, 200))
  const pid = Number(execFileSync('pgrep', ['-n', '-f', `${sleeper.ffmpeg} 30`], { encoding: 'utf8' }).trim())
  // A pid file an hour old naming that pid: a process started since then is someone else's.
  writeFileSync(pidFile, `${pid}\n${sleeper.ffmpeg}`)
  const hourAgo = new Date(Date.now() - 3600_000)
  utimesSync(pidFile, hourAgo, hourAgo)
  stopLeftoverFfmpeg(pidFile, sleeper)
  const ended = await Promise.race([later.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 500))])
  assert.equal(ended, false, 'still running')
  assert.equal(existsSync(pidFile), false)
  process.kill(pid, 'SIGKILL')
  await assert.rejects(later)
  // Anything but a small regular file is ignored.
  mkdirSync(pidFile)
  stopLeftoverFfmpeg(pidFile, sleeper)
})
