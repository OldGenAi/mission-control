// Video recipes: each one builds a complete ComfyUI graph from a small set of checked values.
// The page and Dave pick a recipe and fill in its parameters; they can never send a graph or
// choose nodes, so only the core nodes listed here ever run.
//
// Security-sensitive. Do not modify without Claude review.

import type { ParamValues, RecipeParams } from './recipe-types.js'

export interface ComfyNode { class_type: string; inputs: Record<string, unknown> }
export type ComfyGraph = Record<string, ComfyNode>

export interface Recipe {
  id: string
  name: string
  description: string
  /** Plain-words hardware note shown next to the recipe. */
  hardware: string
  /** Free graphics memory (GB) the recipe needs before it is started. */
  minFreeVramGb: number
  /** What it makes: a video (an MP4 from ComfyUI's output folder) or a picture (a PNG, from its output or temp folder). */
  output: 'video' | 'picture'
  params: RecipeParams
  /** Model files it loads, by ComfyUI model folder (checked before a job starts). */
  models: ReadonlyArray<{ folder: string; file: string }>
  build(values: ParamValues, outputPrefix: string): ComfyGraph
}

/** Node class names used by a graph, for the "is everything installed" check. */
export function nodeClasses(graph: ComfyGraph): string[] {
  return [...new Set(Object.values(graph).map((n) => n.class_type))].sort()
}

// Builds a graph with short sequential node ids and returns references as [id, output].
export class GraphBuilder {
  readonly graph: ComfyGraph = {}
  private next = 1

  add(class_type: string, inputs: Record<string, unknown>): (output?: number) => [string, number] {
    const id = String(this.next++)
    this.graph[id] = { class_type, inputs }
    return (output = 0) => [id, output]
  }
}

const LTX_SIZES: Record<string, [number, number]> = {
  // About 0.9 megapixels. The first pass runs at half size, which must be a multiple of 32
  // (ComfyUI rounds it down otherwise): 1280x704 is what LTX-2.5 produced on the Beelink.
  '16:9': [1280, 704],
  '9:16': [704, 1280],
  '1:1': [960, 960],
}
const LTX_FPS = 24
const LTX_DEFAULT_NEGATIVE = 'blurry, distorted, low quality, watermark, text'

const LTX_MODELS = [
  { folder: 'diffusion_models', file: 'ltx-2.5-22b-distilled-transformer-nvfp4.safetensors' },
  { folder: 'text_encoders', file: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors' },
  { folder: 'vae', file: 'ltx-2.5-video-vae-conv-bf16.safetensors' },
  { folder: 'vae', file: 'ltx-2.5-audio-vae-bf16.safetensors' },
  { folder: 'latent_upscale_models', file: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors' },
] as const
const LTX_HARDWARE = 'Needs an NVIDIA card with 16 GB of video memory (tested on an RTX 5070 Ti: about a minute for 5 seconds).'
const LTX_PARAMS: RecipeParams = {
  prompt: { kind: 'text', maxLength: 2000, required: true },
  negative: { kind: 'text', maxLength: 500, default: LTX_DEFAULT_NEGATIVE },
  seconds: { kind: 'int', min: 1, max: 10, default: 5 },
  aspect: { kind: 'choice', options: Object.keys(LTX_SIZES), default: '16:9' },
  seed: { kind: 'int', min: 0, max: 2 ** 48, default: 0 },
}

/**
 * The LTX-2.5 graph: a half-size pass, a 2x latent upscale, then a short refining pass, with
 * sound. With `image` (a name in ComfyUI's input folder) the picture becomes the first frame in
 * both passes, wired as in ComfyUI's own "Image to Video (LTX-2.5)" blueprint.
 */
function buildLtx(values: ParamValues, outputPrefix: string, image?: string): ComfyGraph {
  const [width, height] = LTX_SIZES[values.aspect as string]!
  const frames = (values.seconds as number) * LTX_FPS + 1
  const seed = values.seed as number
  const g = new GraphBuilder()

  const model = g.add('UNETLoader', { unet_name: LTX_MODELS[0].file, weight_dtype: 'default' })
  // On the card: on the processor it took over 70 s just to read the prompt and ran the CPU at
  // 90 C (Beelink, 2026-10-21). On the card it briefly peaks at about 15.1 GB while loading.
  const clip = g.add('CLIPLoader', { clip_name: LTX_MODELS[1].file, type: 'ltxv', device: 'default' })
  const vae = g.add('VAELoader', { vae_name: LTX_MODELS[2].file })
  const audioVae = g.add('VAELoader', { vae_name: LTX_MODELS[3].file })
  const upscaler = g.add('LatentUpscaleModelLoader', { model_name: LTX_MODELS[4].file })

  const positive = g.add('CLIPTextEncode', { text: values.prompt, clip: clip() })
  const negative = g.add('CLIPTextEncode', { text: values.negative, clip: clip() })
  const conditioning = g.add('LTXVConditioning', { frame_rate: LTX_FPS, positive: positive(), negative: negative() })

  // The picture, if any: longer side to 1536 px, then LTX's light compression so it matches
  // what the model saw in training (the blueprint's values).
  let picture: ((output?: number) => [string, number]) | null = null
  if (image !== undefined) {
    const loaded = g.add('LoadImage', { image })
    const resized = g.add('ResizeImageMaskNode', {
      input: loaded(0), resize_type: 'scale longer dimension', 'resize_type.longer_size': 1536, scale_method: 'lanczos',
    })
    picture = g.add('LTXVPreprocess', { image: resized(), img_compression: 18 })
  }

  const emptyVideo = g.add('EmptyLTXVLatentVideo', { width: width / 2, height: height / 2, length: frames, batch_size: 1 })
  const firstVideo = picture
    ? g.add('LTXVImgToVideoInplace', { vae: vae(), image: picture(), latent: emptyVideo(), strength: 0.7, bypass: false })
    : emptyVideo
  const emptyAudio = g.add('LTXVEmptyLatentAudio', { frames_number: frames, frame_rate: LTX_FPS, batch_size: 1, audio_vae: audioVae() })
  const start = g.add('LTXVConcatAVLatent', { video_latent: firstVideo(), audio_latent: emptyAudio() })

  const sampler = g.add('KSamplerSelect', { sampler_name: 'euler_ancestral' })
  const guider = g.add('LTXVDualCFGGuider', { video_cfg: 1.0, audio_cfg: 1.0, model: model(), positive: conditioning(0), negative: conditioning(1) })

  const noise1 = g.add('RandomNoise', { noise_seed: seed })
  const sigmas1 = g.add('ManualSigmas', { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' })
  const pass1 = g.add('SamplerCustomAdvanced', { noise: noise1(), guider: guider(), sampler: sampler(), sigmas: sigmas1(), latent_image: start() })
  const split1 = g.add('LTXVSeparateAVLatent', { av_latent: pass1() })

  const upscaled = g.add('LTXVLatentUpsampler', { samples: split1(0), upscale_model: upscaler(), vae: vae() })
  const secondVideo = picture
    ? g.add('LTXVImgToVideoInplace', { vae: vae(), image: picture(), latent: upscaled(), strength: 1.0, bypass: false })
    : upscaled
  const rejoined = g.add('LTXVConcatAVLatent', { video_latent: secondVideo(), audio_latent: split1(1) })
  const noise2 = g.add('RandomNoise', { noise_seed: seed + 1 })
  const sigmas2 = g.add('ManualSigmas', { sigmas: '0.85, 0.7250, 0.4219, 0.0' })
  const pass2 = g.add('SamplerCustomAdvanced', { noise: noise2(), guider: guider(), sampler: sampler(), sigmas: sigmas2(), latent_image: rejoined() })
  const split2 = g.add('LTXVSeparateAVLatent', { av_latent: pass2() })

  const images = g.add('VAEDecodeTiled', { tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16, samples: split2(0), vae: vae() })
  const audio = g.add('LTXVAudioVAEDecode', { samples: split2(1), audio_vae: audioVae() })
  const video = g.add('CreateVideo', { fps: LTX_FPS, bit_depth: 8, color_space: 'sRGB', codec: 'none', images: images(), audio: audio() })
  g.add('SaveVideo', { filename_prefix: outputPrefix, format: 'auto', 'format.codec': 'auto', codec: 'auto', video: video() })
  return g.graph
}

const ltx25TextToVideo: Recipe = {
  id: 'ltx25-t2v',
  name: 'LTX-2.5 text to video',
  description: 'A short clip with sound from a written description.',
  hardware: LTX_HARDWARE,
  minFreeVramGb: 14,
  output: 'video',
  params: LTX_PARAMS,
  models: LTX_MODELS,
  build: (values, outputPrefix) => buildLtx(values, outputPrefix),
}

const ltx25ImageToVideo: Recipe = {
  id: 'ltx25-i2v',
  name: 'LTX-2.5 picture to video',
  description: 'Brings a still picture to life as a short clip with sound. The picture becomes the first frame.',
  hardware: LTX_HARDWARE,
  minFreeVramGb: 14,
  output: 'video',
  params: { image: { kind: 'image', required: true }, ...LTX_PARAMS },
  models: LTX_MODELS,
  // By the time the graph is built, the job has copied the picture into ComfyUI and put the
  // name it was given in place of the stored picture's id.
  build: (values, outputPrefix) => buildLtx(values, outputPrefix, values.image as string),
}

const WAN_SIZES: Record<string, [number, number]> = {
  // 480p, the size that runs on smaller cards (Wan 2.2 5B also does 720p, much slower).
  '16:9': [832, 480],
  '9:16': [480, 832],
  '1:1': [640, 640],
}
const WAN_FPS = 24

// Apache-2.0 model, so it is the free choice for any card. Uses the base model only (no speed-up
// LoRA, whose licence we have not checked).
const wan22TextToVideo: Recipe = {
  id: 'wan22-5b-t2v',
  name: 'Wan 2.2 (5B) text to video',
  description: 'A short silent clip from a written description, for smaller graphics cards.',
  hardware: 'Runs on NVIDIA cards with 8 GB of video memory or more (slower on smaller cards; not yet timed on one).',
  minFreeVramGb: 6,
  output: 'video',
  params: {
    prompt: { kind: 'text', maxLength: 2000, required: true },
    negative: { kind: 'text', maxLength: 500, default: 'blurry, static, distorted, extra fingers, low quality, watermark, text' },
    seconds: { kind: 'int', min: 1, max: 5, default: 5 },
    aspect: { kind: 'choice', options: Object.keys(WAN_SIZES), default: '16:9' },
    seed: { kind: 'int', min: 0, max: 2 ** 48, default: 0 },
  },
  models: [
    { folder: 'diffusion_models', file: 'wan2.2_ti2v_5B_fp16.safetensors' },
    { folder: 'text_encoders', file: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors' },
    { folder: 'vae', file: 'wan2.2_vae.safetensors' },
  ],
  build(values, outputPrefix) {
    const [width, height] = WAN_SIZES[values.aspect as string]!
    // Wan wants a frame count of 4n + 1.
    const length = (values.seconds as number) * WAN_FPS + 1
    const g = new GraphBuilder()
    const model = g.add('UNETLoader', { unet_name: this.models[0]!.file, weight_dtype: 'default' })
    const clip = g.add('CLIPLoader', { clip_name: this.models[1]!.file, type: 'wan', device: 'default' })
    const vae = g.add('VAELoader', { vae_name: this.models[2]!.file })
    const positive = g.add('CLIPTextEncode', { text: values.prompt, clip: clip() })
    const negative = g.add('CLIPTextEncode', { text: values.negative, clip: clip() })
    const shifted = g.add('ModelSamplingSD3', { shift: 8.0, model: model() })
    const latent = g.add('Wan22ImageToVideoLatent', { width, height, length, batch_size: 1, vae: vae() })
    const sampled = g.add('KSampler', {
      seed: values.seed, steps: 20, cfg: 5.0, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1.0,
      model: shifted(), positive: positive(), negative: negative(), latent_image: latent(),
    })
    const images = g.add('VAEDecode', { samples: sampled(), vae: vae() })
    const video = g.add('CreateVideo', { images: images(), fps: WAN_FPS })
    g.add('SaveVideo', { video: video(), filename_prefix: outputPrefix, format: 'auto', codec: 'auto' })
    return g.graph
  },
}

export const RECIPES: readonly Recipe[] = [ltx25TextToVideo, ltx25ImageToVideo, wan22TextToVideo]

export function findRecipe(id: unknown): Recipe | undefined {
  return RECIPES.find((r) => r.id === id)
}
