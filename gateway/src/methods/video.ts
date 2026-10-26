import { registerMethod } from '../router.js'
import { getConfig } from '../auth.js'
import { RECIPES, nodeClasses, findRecipe } from '../video/recipes.js'
import { ComfyClient, checkComfyUrl } from '../video/comfyui.js'
import { issueMediaLink } from '../video/media-links.js'
import { VideoRequestError, listensBeyondThisComputer, type VideoJobs } from '../video/jobs.js'
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

export function registerVideoMethods(jobs: VideoJobs, comfyUrl: () => string): void {
  registerMethod('video.recipes', async () => ({
    recipes: RECIPES.map(({ id, name, description, hardware, params }) => ({ id, name, description, hardware, params })),
  }))

  // Is ComfyUI there, how was it started, and does it have what each recipe needs?
  registerMethod('video.status', async () => {
    const url = comfyUrl()
    const checked = checkComfyUrl(url)
    if ('error' in checked) return { reachable: false, url, problem: checked.error }
    const client = new ComfyClient(checked.url)
    let stats
    try { stats = await client.stats() } catch { stats = null }
    if (!stats) return { reachable: false, url, problem: `ComfyUI isn't answering at ${url}. Mission Control doesn't start it: start ComfyUI on this computer (see Making videos in the README), or fix the address in Settings.` }

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

  registerMethod('video.link', async (params) => {
    const id = videoId(params['id'])
    if (!jobs.filePath(id)) invalid('That video is not available.')
    return { link: issueMediaLink(getConfig().sessionSecret, id) }
  })
}
