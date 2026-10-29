import { registerMethod } from '../router.js'
import { getConfig } from '../auth.js'
import { RECIPES, nodeClasses, findRecipe } from '../video/recipes.js'
import { ComfyClient, checkComfyUrl } from '../video/comfyui.js'
import { issueMediaLink, issuePictureLink } from '../video/media-links.js'
import { VideoRequestError, listensBeyondThisComputer, type VideoJobs } from '../video/jobs.js'
import type { VideoCast } from '../video/cast.js'
import type { Film, FilmStore } from '../video/films.js'
import type { FilmDirector } from '../video/film-director.js'
import type { FilmHelper } from '../video/film-helper.js'
import { ffmpegMajor, type FfmpegTools } from '../video/ffmpeg.js'
import type { RecipeParams, ParamValues } from '../video/recipe-types.js'

function invalid(message: string): never {
  throw { code: 'INVALID_PARAMS', message }
}

function videoId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) invalid('id must be a video id')
  return value
}

// Recipe defaults, used to build a sample graph for the "what's installed" check.
function defaults(params: RecipeParams): ParamValues {
  const values: ParamValues = {}
  for (const [name, spec] of Object.entries(params)) {
    if ('default' in spec && spec.default !== undefined) values[name] = spec.default
    else if (spec.kind === 'text') values[name] = 'x'
    else if (spec.kind === 'int') values[name] = spec.min
    else if (spec.kind === 'choice') values[name] = spec.options[0]!
    else if (spec.kind === 'image') values[name] = 'check.png'
  }
  return values
}

// A film store refusal reaches the page as INVALID_PARAMS with its plain words.
async function refusals<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof VideoRequestError) invalid(err.message)
    throw err
  }
}

// Signed links (an hour) for every picture and clip a film shows, by id.
function filmLinks(film: Film, secret: string): Record<string, string> {
  const links: Record<string, string> = {}
  const pictures = [
    ...film.cast.flatMap((c) => [c.pictureId, c.turnaroundId, c.faceId]),
    ...film.places.flatMap((p) => [p.masterId, p.emptyId, p.sheetId]),
    ...film.shots.flatMap((s) => [s.startId, s.endId]),
    ...film.pictures.map((p) => p.imageId),
  ]
  for (const id of pictures) if (id) links[id] = issuePictureLink(secret, id)
  for (const { clipId } of film.shots) if (clipId) links[clipId] = issueMediaLink(secret, clipId)
  if (film.videoId) links[film.videoId] = issueMediaLink(secret, film.videoId)
  return links
}

export function registerVideoMethods(jobs: VideoJobs, cast: VideoCast, comfyUrl: () => string, films: FilmStore, ffmpeg: FfmpegTools | null): void {
  registerMethod('video.recipes', async () => ({
    recipes: RECIPES.map(({ id, name, description, hardware, params }) => ({ id, name, description, hardware, params })),
  }))

  // Is ComfyUI there, how was it started, and does it have what each recipe needs?
  registerMethod('video.status', async () => {
    const url = comfyUrl()
    // Found once at start (Storyboard spec 6.2): the page shows the path, and greys out Make film without it.
    // An old release is pointed out, not refused: Ubuntu backports fixes without changing the number.
    const major = ffmpeg ? ffmpegMajor(ffmpeg.version) : null
    const ffmpegFound = ffmpeg ? { path: ffmpeg.ffmpeg, version: ffmpeg.version, old: major !== null && major < 7 } : null
    const checked = checkComfyUrl(url)
    if ('error' in checked) return { reachable: false, url, problem: checked.error, ffmpeg: ffmpegFound }
    const client = new ComfyClient(checked.url)
    let stats
    try { stats = await client.stats() } catch { stats = null }
    if (!stats) return { reachable: false, url, ffmpeg: ffmpegFound, problem: `ComfyUI isn't answering at ${url}. Mission Control doesn't start it: start ComfyUI on this computer (see Making videos in the README), or fix the address in Settings.` }

    const warnings: string[] = []
    if (listensBeyondThisComputer(stats.argv)) warnings.push('ComfyUI was started with --listen, so other devices can reach it. Start it without --listen.')
    if (!stats.argv.some((a) => a === '--preview-method' || a.startsWith('--preview-method='))) {
      warnings.push('Live previews are off. Start ComfyUI with --preview-method auto to see the video take shape.')
    }
    if (!stats.argv.includes('--disable-metadata')) {
      warnings.push('ComfyUI saves your prompt inside every file it makes. Mission Control removes it from its own copies; starting ComfyUI with --disable-metadata stops it at the source.')
    }
    const recipes = []
    for (const recipe of RECIPES) {
      let missing: string[]
      try { missing = await client.missing(nodeClasses(recipe.build(defaults(recipe.params), 'check')), recipe.models) } catch { missing = ['could not check'] }
      recipes.push({ id: recipe.id, missing })
    }
    return {
      reachable: true, url, version: stats.version, warnings, recipes,
      device: stats.device ? { name: stats.device.name, vramTotalGb: stats.device.vramTotal / 1024 ** 3, vramFreeGb: stats.device.vramFree / 1024 ** 3 } : null,
      diskBytes: jobs.diskUsage(),
      ffmpeg: ffmpegFound,
    }
  })

  registerMethod('video.submit', async (params) => {
    if (!findRecipe(params['recipeId'])) invalid('There is no recipe with that name.')
    try {
      return { id: jobs.submit(params['recipeId'], params['params']) }
    } catch (err) {
      if (err instanceof VideoRequestError) invalid(err.message)
      throw err
    }
  })

  // A picture for image-to-video, as base64. It's checked and stored under an id the gateway
  // picks; recipes then take that id.
  registerMethod('video.uploadImage', async (params) => {
    try {
      const { id, type, width, height } = jobs.uploadImage(params['data'])
      return { id, type, width, height }
    } catch (err) {
      if (err instanceof VideoRequestError) invalid(err.message)
      throw err
    }
  })

  registerMethod('video.cancel', async (params) => ({ cancelled: jobs.cancel(videoId(params['id'])) }))

  registerMethod('video.delete', async (params) => ({ deleted: jobs.delete(videoId(params['id'])) }))

  // A starred video survives video.clearUnkept.
  registerMethod('video.keep', async (params) => {
    if (typeof params['kept'] !== 'boolean') invalid('kept must be true or false')
    return { kept: jobs.keep(videoId(params['id']), params['kept']) }
  })

  // Clears only the videos the page names (the ones it is showing), so nothing unseen goes.
  registerMethod('video.clearUnkept', async (params) => {
    const ids = params['ids']
    if (!Array.isArray(ids) || ids.length > 200) invalid('ids must be a list of at most 200 video ids')
    return { deleted: jobs.clearUnkept(ids.map(videoId)) }
  })

  // Finished videos come with a signed link (an hour) the page can put in a <video> element.
  // The disk numbers feed the page's storage bar, which shows even while ComfyUI is off.
  registerMethod('video.list', async (params) => {
    const limit = Number.isInteger(params['limit']) ? (params['limit'] as number) : 50
    const secret = getConfig().sessionSecret
    return {
      videos: jobs.list(limit).map((v) => ({ ...v, link: v.status === 'done' ? issueMediaLink(secret, v.id) : null })),
      diskBytes: jobs.diskUsage(),
      diskLimitBytes: jobs.diskLimit,
    }
  })

  // The cast: characters with fixed prompt wording and a picture, so a story describes them the same way every clip.
  registerMethod('video.cast.list', async () => ({ cast: cast.list() }))

  registerMethod('video.cast.save', async (params) => {
    try {
      return { member: cast.save(params['member']) }
    } catch (err) {
      if (err instanceof VideoRequestError) invalid(err.message)
      throw err
    }
  })

  registerMethod('video.cast.delete', async (params) => ({ deleted: cast.delete(params['id']) }))

  registerMethod('video.link', async (params) => {
    const id = videoId(params['id'])
    if (!jobs.filePath(id)) invalid('That video is not available.')
    return { link: issueMediaLink(getConfig().sessionSecret, id) }
  })

  // The Storyboard's films (storyboard spec 8). Every field and id is checked in the film store; the page drives
  // every step, and no AI tool calls these (spec 16).
  registerMethod('video.film.list', async () => {
    const secret = getConfig().sessionSecret
    return { films: films.list().map((f) => ({ ...f, thumbLink: f.thumbId ? issuePictureLink(secret, f.thumbId) : null })) }
  })

  registerMethod('video.film.get', async (params) => {
    const film = films.get(params['id'])
    if (!film) invalid('That film no longer exists.')
    return { film, links: filmLinks(film, getConfig().sessionSecret) }
  })

  registerMethod('video.film.create', async (params) => refusals(() => ({ film: films.create(params['film']) })))
  registerMethod('video.film.update', async (params) => refusals(() => ({ film: films.update(params['id'], params['film']) })))

  registerMethod('video.film.cast.kind', async (params) => refusals(() => {
    films.setKind(params['filmId'], params['castId'], params['kind'])
    return { film: films.get(params['filmId']) }
  }))
  registerMethod('video.film.place.save', async (params) => refusals(() => ({ place: films.savePlace(params['filmId'], params['place']) })))
  registerMethod('video.film.place.delete', async (params) => refusals(() => ({ deleted: films.deletePlace(params['filmId'], params['id']) })))
  registerMethod('video.film.place.move', async (params) => refusals(() => {
    films.movePlace(params['filmId'], params['id'], params['position'])
    return { moved: true }
  }))

  registerMethod('video.film.shot.save', async (params) => refusals(() => ({ shot: films.saveShot(params['filmId'], params['shot']) })))
  registerMethod('video.film.shot.delete', async (params) => refusals(() => ({ deleted: films.deleteShot(params['filmId'], params['id']) })))
  registerMethod('video.film.shot.move', async (params) => refusals(() => {
    films.moveShot(params['filmId'], params['id'], params['position'])
    return { moved: true }
  }))

  registerMethod('video.film.pictures.choose', async (params) => refusals(() => {
    films.choose(params['filmId'], params['pictureId'])
    return { chosen: true }
  }))
}

// Planning with the local helper, and making a film's pictures and the film itself through the director (one job on
// the graphics card at a time).
export function registerFilmMakingMethods(director: FilmDirector, films: FilmStore, helper: FilmHelper): void {
  // A running helper request per film, so Stop can abort it.
  const planning = new Map<string, AbortController>()

  // Plans the film's places and shots from its story. Returns { confirm: address } when the model server is on the
  // local network and the person hasn't said yes to it yet; the page asks, then calls again with allowAddress.
  registerMethod('video.film.plan', async (params) => refusals(async () => {
    const replace = params['replace'] === true
    const allowAddress = typeof params['allowAddress'] === 'string' ? params['allowAddress'] : undefined
    const film = films.copyCastForPlan(params['filmId'])
    if ((film.places.length > 0 || film.shots.length > 0) && !replace) invalid('This film already has a plan. Replace it?')
    if (planning.has(film.id)) invalid('The helper is already planning this film.')
    const stop = new AbortController()
    planning.set(film.id, stop)
    try {
      const asked = await helper.plan({ story: film.story, seconds: film.seconds, look: film.look, cast: film.cast.map(({ name, wording, kind }) => ({ name, wording, kind })) },
        { signal: stop.signal, ...(allowAddress ? { allowAddress } : {}) })
      if ('confirm' in asked) return { confirm: asked.confirm }
      films.replacePlan(film.id, asked.plan, replace)
      return { film: films.get(film.id), warnings: asked.warnings }
    } finally {
      planning.delete(film.id)
    }
  }))

  // { round: 'places' | 'shots' } for a picture round, or { ownerId, role } for two more pictures (Make more).
  registerMethod('video.film.pictures.make', async (params) => refusals(async () => {
    const request = params['request']
    if (typeof request !== 'object' || request === null || Array.isArray(request)) invalid('Say which pictures to make.')
    const { round, ownerId, role } = request as Record<string, unknown>
    if (round === 'places' || round === 'shots') await director.makePictures(params['filmId'], { round })
    else if (typeof role === 'string') await director.makePictures(params['filmId'], { ownerId, role })
    else invalid('Say which pictures to make.')
    return { queued: true }
  }))

  // Deleting a film stops its pictures first (a round may be running or waiting), then the store removes its files.
  registerMethod('video.film.delete', async (params) => refusals(async () => {
    await director.stop(params['id'])
    return { deleted: await films.delete(params['id']) }
  }))

  registerMethod('video.film.make', async (params) => refusals(() => {
    director.make(params['filmId'])
    return { started: true }
  }))

  registerMethod('video.film.stop', async (params) => refusals(async () => {
    if (typeof params['filmId'] === 'string') planning.get(params['filmId'])?.abort()
    await director.stop(params['filmId'])
    return { stopped: true }
  }))

  registerMethod('video.film.redo', async (params) => refusals(() => {
    if (typeof params['newSeed'] !== 'boolean') invalid('newSeed must be true or false')
    director.redo(params['filmId'], params['shotId'], params['newSeed'])
    return { started: true }
  }))
}
