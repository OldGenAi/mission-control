// The Storyboard's own ComfyUI recipes (storyboard spec 6.1). Like recipes.ts, each builds a complete graph from a few
// checked values, so the page can never send a graph, a node or a file name. They are kept out of RECIPES: only the
// Storyboard hands them to the queue (VideoJobs.submitFilm), so video.submit can never name one.
//
// Security-sensitive. Do not modify without Claude review.
//
// The picture edits are Qwen Image Edit 2511 as in ComfyUI's own "Image Edit (Qwen 2511)" blueprint (40 steps, cfg 4,
// shift 3.1), and its fast form with the Lightning 4-step add-on (4 steps, cfg 1): the graphs of
// local-video\jobs\qwen_scene_still.py, which made the red door films' pictures. They save with PreviewImage, so the
// candidates go to ComfyUI's temp folder (cleared when it restarts), not its output folder.

import { MAX_PROMPT } from './film-wording.js'
import { GraphBuilder, type ComfyGraph, type Recipe } from './recipes.js'
import type { ParamValues, RecipeParams } from './recipe-types.js'

const QWEN_MODELS = [
  { folder: 'diffusion_models', file: 'qwen_image_edit_2511_fp8mixed.safetensors' },
  { folder: 'text_encoders', file: 'qwen_2.5_vl_7b_fp8_scaled.safetensors' },
  { folder: 'vae', file: 'qwen_image_vae.safetensors' },
] as const
const LIGHTNING = { folder: 'loras', file: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors' } as const
const QWEN_HARDWARE = 'Needs an NVIDIA card with 16 GB of video memory (tested on an RTX 5070 Ti: about 20 seconds a picture fast, 3 minutes fine).'

const EDIT_PARAMS: RecipeParams = {
  prompt: { kind: 'text', maxLength: MAX_PROMPT, required: true },
  image1: { kind: 'image', required: true },
  // What a character looks like, for an edit that adds it to picture 1.
  image2: { kind: 'image' },
  seed: { kind: 'int', min: 0, max: 2 ** 48, default: 0 },
}

function buildEdit(values: ParamValues, fast: boolean): ComfyGraph {
  const g = new GraphBuilder()
  const unet = g.add('UNETLoader', { unet_name: QWEN_MODELS[0].file, weight_dtype: 'default' })
  const model = fast ? g.add('LoraLoaderModelOnly', { model: unet(), lora_name: LIGHTNING.file, strength_model: 1 }) : unet
  const clip = g.add('CLIPLoader', { clip_name: QWEN_MODELS[1].file, type: 'qwen_image', device: 'default' })
  const vae = g.add('VAELoader', { vae_name: QWEN_MODELS[2].file })

  const picture1 = g.add('FluxKontextImageScale', { image: g.add('LoadImage', { image: values.image1 })() })
  const picture2 = values.image2 === undefined ? null : g.add('LoadImage', { image: values.image2 })
  const positive = g.add('TextEncodeQwenImageEditPlus', {
    clip: clip(), prompt: values.prompt, vae: vae(), image1: picture1(), ...(picture2 ? { image2: picture2() } : {}),
  })
  const negative = g.add('TextEncodeQwenImageEditPlus', { clip: clip(), prompt: '', vae: vae(), image1: picture1() })
  const reference = (conditioning: () => [string, number]) =>
    g.add('FluxKontextMultiReferenceLatentMethod', { conditioning: conditioning(), reference_latents_method: 'index_timestep_zero' })
  const sampling = g.add('CFGNorm', { model: g.add('ModelSamplingAuraFlow', { model: model(), shift: 3.1 })(), strength: 1 })
  const sampled = g.add('KSampler', {
    model: sampling(), seed: values.seed, steps: fast ? 4 : 40, cfg: fast ? 1 : 4, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
    positive: reference(positive)(), negative: reference(negative)(), latent_image: g.add('VAEEncode', { pixels: picture1(), vae: vae() })(),
  })
  g.add('PreviewImage', { images: g.add('VAEDecode', { samples: sampled(), vae: vae() })() })
  return g.graph
}

export const FILM_EDIT_FAST: Recipe = {
  id: 'film-edit-fast',
  name: 'Picture edit (fast)',
  description: 'Qwen Image Edit 2511 with the Lightning 4-step add-on: keeps a place\'s layout, ignores framing words.',
  hardware: QWEN_HARDWARE,
  minFreeVramGb: 12,
  output: 'picture',
  params: EDIT_PARAMS,
  models: [...QWEN_MODELS, LIGHTNING],
  build: (values) => buildEdit(values, true),
}

export const FILM_EDIT_FINE: Recipe = {
  id: 'film-edit-fine',
  name: 'Picture edit (fine)',
  description: 'Qwen Image Edit 2511 at 40 steps: slower and sharper, follows framing words (close-ups, the face panel).',
  hardware: QWEN_HARDWARE,
  minFreeVramGb: 12,
  output: 'picture',
  params: EDIT_PARAMS,
  models: QWEN_MODELS,
  build: (values) => buildEdit(values, false),
}

// The shot: LTX-2.5 guided by the place's reference sheet through Lightricks' Ingredients IC-LoRA, with the start (and,
// except for a close-up, the end) picture pinned: local-video\jobs\ltx25_ingredients.py, which made the 1:26 film's shots.
// Hand test T1 (29 Oct, jobs\t1-nodes-2026-10-29) found ComfyUI's own LoraLoaderModelOnly + GetICLoRAParameters +
// LTXVAddGuide make the same clip, pixel for pixel, as Lightricks' node pack, so no custom nodes are needed.
const SHOT_MODELS = [
  { folder: 'diffusion_models', file: 'ltx-2.5-22b-distilled-transformer-nvfp4.safetensors' },
  { folder: 'text_encoders', file: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors' },
  { folder: 'vae', file: 'ltx-2.5-video-vae-conv-bf16.safetensors' },
  { folder: 'vae', file: 'ltx-2.5-audio-vae-bf16.safetensors' },
  { folder: 'loras', file: 'ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors' },
] as const
const SHOT_FPS = 24
const SHOT_SIZE = { width: 960, height: 544 }
// Strength 1.5 on our nvfp4 base: at Lightricks' 1.0 the clip only copies the sheet's layout (RECIPE.md).
const INGREDIENTS_STRENGTH = 1.5
const START_PIN = 0.9
const END_PIN = 0.7
// CFG 1 ignores it, as in the proven script; the shot's words are all positive (film-wording.ts).
const SHOT_NEGATIVE = 'worst quality, inconsistent motion, blurry, jittery, distorted'

const SHOT_PARAMS: RecipeParams = {
  prompt: { kind: 'text', maxLength: MAX_PROMPT, required: true },
  sheet: { kind: 'image', required: true },
  start: { kind: 'image', required: true },
  // None for a close-up: it has its own start picture and ends where the shot ends.
  end: { kind: 'image' },
  // 4 to 8 seconds at 24 fps (97 to 193 frames).
  frames: { kind: 'int', min: 97, max: 193, default: 121 },
  seed: { kind: 'int', min: 0, max: 2 ** 48, default: 0 },
}

function buildShot(values: ParamValues, outputPrefix: string): ComfyGraph {
  // LTX takes 8n+1 frames; the director asks for seconds x 24 + 1, which always is.
  const frames = Math.floor(((values.frames as number) - 1) / 8) * 8 + 1
  const g = new GraphBuilder()
  const lora = g.add('LoraLoaderModelOnly', {
    model: g.add('UNETLoader', { unet_name: SHOT_MODELS[0].file, weight_dtype: 'default' })(), lora_name: SHOT_MODELS[4].file, strength_model: INGREDIENTS_STRENGTH,
  })
  const icParameters = g.add('GetICLoRAParameters', { iclora_model: lora() })
  const vae = g.add('VAELoader', { vae_name: SHOT_MODELS[2].file })
  const audioVae = g.add('VAELoader', { vae_name: SHOT_MODELS[3].file })
  const clip = g.add('CLIPLoader', { clip_name: SHOT_MODELS[1].file, type: 'ltxv', device: 'default' })
  const conditioning = g.add('LTXVConditioning', {
    positive: g.add('CLIPTextEncode', { clip: clip(), text: values.prompt })(),
    negative: g.add('CLIPTextEncode', { clip: clip(), text: SHOT_NEGATIVE })(), frame_rate: SHOT_FPS,
  })
  const scaled = (image: unknown) => g.add('ImageScale', { image: g.add('LoadImage', { image })(), upscale_method: 'lanczos', ...SHOT_SIZE, crop: 'center' })
  // The sheet is a guide video: the same picture for every frame.
  const sheetVideo = g.add('RepeatImageBatch', { image: scaled(values.sheet)(), amount: frames })
  const latent = g.add('EmptyLTXVLatentVideo', { ...SHOT_SIZE, length: frames, batch_size: 1 })
  let guided = g.add('LTXVAddGuide', {
    positive: conditioning(0), negative: conditioning(1), vae: vae(), latent: latent(), image: sheetVideo(), frame_idx: 0, strength: 1, iclora_parameters: icParameters(),
  })
  const pin = (image: unknown, frameIdx: number, strength: number) => {
    const before = guided
    guided = g.add('LTXVAddGuide', {
      positive: before(0), negative: before(1), vae: vae(), latent: before(2),
      image: g.add('LTXVPreprocess', { image: scaled(image)(), img_compression: 18 })(), frame_idx: frameIdx, strength,
    })
  }
  pin(values.start, 0, START_PIN)
  if (values.end !== undefined) pin(values.end, -1, END_PIN)

  const audioLatent = g.add('LTXVEmptyLatentAudio', { frames_number: frames, frame_rate: SHOT_FPS, batch_size: 1, audio_vae: audioVae() })
  const sampled = g.add('SamplerCustomAdvanced', {
    noise: g.add('RandomNoise', { noise_seed: values.seed })(),
    guider: g.add('CFGGuider', { model: lora(), positive: guided(0), negative: guided(1), cfg: 1 })(),
    sampler: g.add('KSamplerSelect', { sampler_name: 'euler_ancestral' })(),
    sigmas: g.add('ManualSigmas', { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' })(),
    latent_image: g.add('LTXVConcatAVLatent', { video_latent: guided(2), audio_latent: audioLatent() })(),
  })
  const split = g.add('LTXVSeparateAVLatent', { av_latent: sampled(1) })
  const cropped = g.add('LTXVCropGuides', { positive: guided(0), negative: guided(1), latent: split(0) })
  const decoded = g.add('VAEDecodeTiled', { samples: cropped(2), vae: vae(), tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 })
  const audio = g.add('LTXVAudioVAEDecode', { samples: split(1), audio_vae: audioVae() })
  g.add('SaveVideo', {
    video: g.add('CreateVideo', { images: decoded(), audio: audio(), fps: SHOT_FPS })(), filename_prefix: outputPrefix, format: 'auto', codec: 'auto',
  })
  return g.graph
}

export const FILM_SHOT: Recipe = {
  id: 'film-shot',
  name: 'Film shot',
  description: 'LTX-2.5 with Lightricks\' Ingredients add-on: the place\'s reference sheet as a guide, the start and end pictures pinned.',
  hardware: 'Needs an NVIDIA card with 16 GB of video memory (tested on an RTX 5070 Ti: about a minute for 4 seconds, 85 seconds for 7).',
  minFreeVramGb: 14,
  output: 'video',
  params: SHOT_PARAMS,
  models: SHOT_MODELS,
  build: buildShot,
}

export const FILM_RECIPES: readonly Recipe[] = [FILM_EDIT_FAST, FILM_EDIT_FINE, FILM_SHOT]
