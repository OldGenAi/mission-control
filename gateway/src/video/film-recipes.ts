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

export const FILM_RECIPES: readonly Recipe[] = [FILM_EDIT_FAST, FILM_EDIT_FINE]
