// Run with: npm test
// The Storyboard's fixed ComfyUI graphs (storyboard spec 6.1): only ComfyUI's own nodes, the words only in the prompt,
// pictures only by the names ComfyUI gave our uploads, and out of reach of the Video page's recipe list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FILM_RECIPES, FILM_EDIT_FAST, FILM_EDIT_FINE } from '../src/video/film-recipes.js'
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
  for (const recipe of FILM_RECIPES) {
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
