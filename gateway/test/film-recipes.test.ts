// Run with: npm test
// The Storyboard's fixed ComfyUI graphs (storyboard spec 6.1): only ComfyUI's own nodes, the words only in the prompt,
// pictures only by the names ComfyUI gave our uploads, and out of reach of the Video page's recipe list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FILM_RECIPES, FILM_EDIT_FAST, FILM_EDIT_FINE, FILM_SHOT } from '../src/video/film-recipes.js'
import { findRecipe, nodeClasses, RECIPES, type ComfyGraph } from '../src/video/recipes.js'
import { validateParams } from '../src/video/params.js'

const EDIT_NODES = ['CFGNorm', 'CLIPLoader', 'FluxKontextImageScale', 'FluxKontextMultiReferenceLatentMethod', 'KSampler', 'LoadImage',
  'ModelSamplingAuraFlow', 'PreviewImage', 'TextEncodeQwenImageEditPlus', 'UNETLoader', 'VAEDecode', 'VAEEncode', 'VAELoader']

const nodes = (graph: ComfyGraph, cls: string) => Object.values(graph).filter((n) => n.class_type === cls)

test('the fast edit is the Lightning 4-step graph, saved to ComfyUI\'s temp folder', () => {
  const graph = FILM_EDIT_FAST.build({ prompt: 'Add Bess to picture 1', image1: 'mission-control/a.png', seed: 7 }, 'unused')
  assert.deepEqual(nodeClasses(graph), [...EDIT_NODES, 'LoraLoaderModelOnly'].sort())
  const sampler = nodes(graph, 'KSampler')[0]!.inputs
  assert.equal(sampler['steps'], 4)
  assert.equal(sampler['cfg'], 1)
  assert.equal(sampler['seed'], 7)
  assert.equal(nodes(graph, 'LoraLoaderModelOnly')[0]!.inputs['lora_name'], 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors')
  assert.equal(nodes(graph, 'PreviewImage').length, 1)
  assert.equal(nodes(graph, 'SaveImage').length, 0, 'nothing kept in ComfyUI\'s output folder')
  assert.deepEqual(nodes(graph, 'LoadImage').map((n) => n.inputs['image']), ['mission-control/a.png'])
})

test('the fine edit is the 40-step graph without the add-on, and takes a second picture', () => {
  const graph = FILM_EDIT_FINE.build({ prompt: 'p', image1: 'mission-control/a.png', image2: 'mission-control/b.png', seed: 9 }, 'unused')
  assert.deepEqual(nodeClasses(graph), EDIT_NODES)
  const sampler = nodes(graph, 'KSampler')[0]!.inputs
  assert.equal(sampler['steps'], 40)
  assert.equal(sampler['cfg'], 4)
  assert.deepEqual(nodes(graph, 'LoadImage').map((n) => n.inputs['image']).sort(), ['mission-control/a.png', 'mission-control/b.png'])
  const encoders = nodes(graph, 'TextEncodeQwenImageEditPlus')
  assert.ok(encoders.some((n) => 'image2' in n.inputs), 'picture 2 reaches the prompt encoder')
})

test('the words go only into the prompt', () => {
  const words = 'Add Bess to picture 1: a border collie'
  const graph = FILM_EDIT_FAST.build({ prompt: words, image1: 'x.png', seed: 1 }, 'unused')
  const holders = Object.values(graph).filter((n) => Object.values(n.inputs).includes(words))
  assert.deepEqual(holders.map((n) => n.class_type), ['TextEncodeQwenImageEditPlus'])
})

test('pictures are picture ids, the prompt is required, and nothing else is accepted', () => {
  for (const recipe of [FILM_EDIT_FAST, FILM_EDIT_FINE]) {
    assert.equal(recipe.output, 'picture')
    assert.equal(validateParams(recipe.params, { prompt: 'x', image1: '../../secret.png', seed: 1 }).ok, false)
    assert.equal(validateParams(recipe.params, { image1: 'a'.repeat(32), seed: 1 }).ok, false)
    assert.equal(validateParams(recipe.params, { prompt: 'x', image1: 'a'.repeat(32), seed: 1, graph: {} }).ok, false)
    assert.equal(validateParams(recipe.params, { prompt: 'x', image1: 'a'.repeat(32), seed: 1 }).ok, true)
  }
})

test('only safetensors models, and none of these recipes can be named on the Video page', () => {
  for (const recipe of FILM_RECIPES) {
    for (const model of recipe.models) assert.match(model.file, /\.safetensors$/)
    assert.equal(findRecipe(recipe.id), undefined)
    assert.equal(RECIPES.includes(recipe), false)
  }
})

// The shot recipe as hand test T1 proved it (local-video\jobs\t1-nodes-2026-10-29): ComfyUI's own nodes give the same
// clip, pixel for pixel, as Lightricks' pack, so the film needs no custom nodes.
const SHOT_NODES = ['CFGGuider', 'CLIPLoader', 'CLIPTextEncode', 'CreateVideo', 'EmptyLTXVLatentVideo', 'GetICLoRAParameters', 'ImageScale',
  'KSamplerSelect', 'LTXVAddGuide', 'LTXVAudioVAEDecode', 'LTXVConcatAVLatent', 'LTXVConditioning', 'LTXVCropGuides', 'LTXVEmptyLatentAudio',
  'LTXVPreprocess', 'LTXVSeparateAVLatent', 'LoadImage', 'LoraLoaderModelOnly', 'ManualSigmas', 'RandomNoise', 'RepeatImageBatch',
  'SamplerCustomAdvanced', 'SaveVideo', 'UNETLoader', 'VAEDecodeTiled', 'VAELoader']
const SHOT_VALUES = { prompt: '### Reference Sheet Description x ### Target Description y', sheet: 'mc/sheet.png', start: 'mc/start.png', end: 'mc/end.png', frames: 121, seed: 424242 }

test('the shot is the T1 graph: core nodes only, Ingredients at 1.5, the sheet as a guide, start pin 0.9 and end pin 0.7', () => {
  const graph = FILM_SHOT.build(SHOT_VALUES, 'mission-control/abc')
  assert.deepEqual(nodeClasses(graph), SHOT_NODES)
  assert.ok(!nodeClasses(graph).some((c) => /^LTXICLoRA|^LTXAddVideoICLoRA|Gemma/.test(c)), 'nothing from Lightricks\' node pack')
  const lora = nodes(graph, 'LoraLoaderModelOnly')[0]!.inputs
  assert.equal(lora['lora_name'], 'ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors')
  assert.equal(lora['strength_model'], 1.5)
  const guides = nodes(graph, 'LTXVAddGuide').map((n) => n.inputs)
  assert.deepEqual(guides.map((g) => [g['frame_idx'], g['strength'], 'iclora_parameters' in g]), [[0, 1, true], [0, 0.9, false], [-1, 0.7, false]])
  assert.deepEqual(nodes(graph, 'LTXVPreprocess').map((n) => n.inputs['img_compression']), [18, 18])
  assert.equal(nodes(graph, 'RepeatImageBatch')[0]!.inputs['amount'], 121, 'the sheet repeated for every frame')
  const latent = nodes(graph, 'EmptyLTXVLatentVideo')[0]!.inputs
  assert.deepEqual([latent['width'], latent['height'], latent['length']], [960, 544, 121])
  assert.equal(nodes(graph, 'CFGGuider')[0]!.inputs['cfg'], 1)
  assert.equal(nodes(graph, 'ManualSigmas')[0]!.inputs['sigmas'], '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0')
  assert.equal(nodes(graph, 'RandomNoise')[0]!.inputs['noise_seed'], 424242)
  assert.equal(nodes(graph, 'SaveVideo')[0]!.inputs['filename_prefix'], 'mission-control/abc')
  assert.deepEqual(nodes(graph, 'LoadImage').map((n) => n.inputs['image']), ['mc/sheet.png', 'mc/start.png', 'mc/end.png'])
})

test('a close-up has no end pin, and the frame count is always 8n+1', () => {
  const { end: _end, ...closeUp } = SHOT_VALUES
  const graph = FILM_SHOT.build(closeUp, 'p')
  assert.deepEqual(nodes(graph, 'LTXVAddGuide').map((n) => n.inputs['frame_idx']), [0, 0])
  assert.equal(nodes(graph, 'LoadImage').length, 2)
  for (const [asked, made] of [[97, 97], [121, 121], [145, 145], [169, 169], [193, 193], [150, 145]] as const) {
    assert.equal(nodes(FILM_SHOT.build({ ...SHOT_VALUES, frames: asked }, 'p'), 'EmptyLTXVLatentVideo')[0]!.inputs['length'], made)
  }
})

test('the shot\'s words go only into the prompt, and its inputs are checked', () => {
  const graph = FILM_SHOT.build(SHOT_VALUES, 'p')
  const holders = Object.values(graph).filter((n) => Object.values(n.inputs).includes(SHOT_VALUES.prompt))
  assert.deepEqual(holders.map((n) => n.class_type), ['CLIPTextEncode'])
  assert.equal(FILM_SHOT.output, 'video')
  const ok = { prompt: 'x', sheet: 'a'.repeat(32), start: 'b'.repeat(32), frames: 97, seed: 1 }
  assert.equal(validateParams(FILM_SHOT.params, ok).ok, true)
  assert.equal(validateParams(FILM_SHOT.params, { ...ok, end: 'c'.repeat(32) }).ok, true)
  assert.equal(validateParams(FILM_SHOT.params, { ...ok, sheet: '../x.png' }).ok, false)
  assert.equal(validateParams(FILM_SHOT.params, { ...ok, frames: 241 }).ok, false)
  assert.equal(validateParams(FILM_SHOT.params, { ...ok, frames: 96 }).ok, false)
  assert.equal(validateParams(FILM_SHOT.params, { ...ok, lora: 2 }).ok, false)
  assert.ok(FILM_RECIPES.includes(FILM_SHOT))
  assert.ok(FILM_SHOT.models.some((m) => m.file === 'ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors' && m.folder === 'loras'))
})
