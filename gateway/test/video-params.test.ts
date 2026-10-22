// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateParams } from '../src/video/params.js'
import type { RecipeParams } from '../src/video/recipe-types.js'

const spec: RecipeParams = {
  prompt: { kind: 'text', maxLength: 20, required: true },
  negative: { kind: 'text', maxLength: 10, default: 'blurry' },
  seed: { kind: 'int', min: 0, max: 1000, default: 7 },
  frames: { kind: 'int', min: 9, max: 121 },
  size: { kind: 'choice', options: ['768x512', '512x768'], default: '768x512' },
  image: { kind: 'image' },
  start: { kind: 'image', required: true },
}
const START = 'a'.repeat(32)

function errorsOf(input: unknown): string[] {
  const result = validateParams(spec, input)
  assert.equal(result.ok, false, 'expected the input to be refused')
  return result.ok ? [] : result.errors
}

test('valid input is accepted and defaults are filled in', () => {
  const result = validateParams(spec, { prompt: 'a dog runs', frames: 49, start: START })
  assert.deepEqual(result, {
    ok: true,
    values: { prompt: 'a dog runs', negative: 'blurry', seed: 7, frames: 49, size: '768x512', start: START },
  })
})

test('a given value wins over the default, and optional values without a default are left out', () => {
  const result = validateParams(spec, { prompt: 'x', negative: 'dark', seed: 0, size: '512x768', start: START })
  assert.deepEqual(result, { ok: true, values: { prompt: 'x', negative: 'dark', seed: 0, size: '512x768', start: START } })
})

test('the input must be a plain object', () => {
  for (const bad of [null, undefined, 'prompt', 42, ['prompt'], true]) {
    assert.deepEqual(errorsOf(bad), ['parameters must be an object'])
  }
})

test('unknown parameters are refused, by name', () => {
  assert.ok(errorsOf({ prompt: 'x', start: START, graph: {} }).includes('unknown parameter: graph'))
  assert.ok(errorsOf({ prompt: 'x', start: START, __proto__x: 1 }).includes('unknown parameter: __proto__x'))
})

test('inherited keys do not count as parameters', () => {
  const sneaky = Object.create({ prompt: 'inherited' }) as Record<string, unknown>
  sneaky.start = START
  assert.ok(errorsOf(sneaky).includes('prompt is required'))
})

test('required values must be present and not empty', () => {
  assert.ok(errorsOf({ start: START }).includes('prompt is required'))
  assert.ok(errorsOf({ prompt: '', start: START }).includes('prompt is required'))
  assert.ok(errorsOf({ prompt: '   ', start: START }).includes('prompt is required'))
  assert.ok(errorsOf({ prompt: 'x' }).includes('start is required'))
})

test('text must be a string within its length, without control characters', () => {
  assert.ok(errorsOf({ prompt: 5, start: START }).includes('prompt must be text'))
  assert.ok(errorsOf({ prompt: 'x'.repeat(21), start: START }).includes('prompt is longer than 20 characters'))
  assert.ok(errorsOf({ prompt: 'bad\u0000byte', start: START }).includes('prompt contains a control character'))
  assert.ok(errorsOf({ prompt: 'esc\u001b[31m', start: START }).includes('prompt contains a control character'))
  const ok = validateParams(spec, { prompt: 'line one\nline\ttwo', start: START })
  assert.equal(ok.ok, true, 'newlines and tabs are allowed in text')
})

test('length is counted in characters, not bytes', () => {
  assert.equal(validateParams(spec, { prompt: '\u00e9'.repeat(20), start: START }).ok, true)
})

test('integers must be whole numbers inside their range', () => {
  assert.ok(errorsOf({ prompt: 'x', start: START, seed: 1.5 }).includes('seed must be a whole number'))
  assert.ok(errorsOf({ prompt: 'x', start: START, seed: '5' }).includes('seed must be a whole number'))
  assert.ok(errorsOf({ prompt: 'x', start: START, seed: Number.NaN }).includes('seed must be a whole number'))
  assert.ok(errorsOf({ prompt: 'x', start: START, seed: Infinity }).includes('seed must be a whole number'))
  assert.ok(errorsOf({ prompt: 'x', start: START, seed: -1 }).includes('seed must be between 0 and 1000'))
  assert.ok(errorsOf({ prompt: 'x', start: START, frames: 122 }).includes('frames must be between 9 and 121'))
  assert.equal(validateParams(spec, { prompt: 'x', start: START, seed: 1000, frames: 9 }).ok, true)
})

test('choices must be one of the listed options', () => {
  assert.ok(errorsOf({ prompt: 'x', start: START, size: '4096x4096' }).includes('size must be one of: 768x512, 512x768'))
  assert.ok(errorsOf({ prompt: 'x', start: START, size: 1 }).includes('size must be one of: 768x512, 512x768'))
})

test('images are ids of 32 lowercase hex digits, never paths', () => {
  for (const bad of ['../secret.png', 'C:\\x.png', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'image.png', 7]) {
    assert.ok(errorsOf({ prompt: 'x', start: bad }).includes('start must be an uploaded image id'), String(bad))
  }
})

test('every problem is reported, not just the first', () => {
  const errors = errorsOf({ seed: -5, size: 'huge', extra: 1 })
  assert.equal(errors.length, 5)
})
