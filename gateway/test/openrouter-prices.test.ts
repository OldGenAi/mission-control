// Run with: npm test
// The OpenRouter price list is fetched only when OpenRouter is set up, so with a local model nothing
// goes to openrouter.ai unasked; with a key it loads at start or within a minute of the key being saved, then hourly.
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { pricesWanted, startPricingRefresh } from '../src/providers/pricing.js'

test('prices are wanted only with an OpenRouter key', () => {
  assert.equal(pricesWanted({ providerKeys: { openrouter: 'sk-or-v1-x' } }), true)
  assert.equal(pricesWanted({ providerKeys: { openrouter: '' } }), false, 'local model only')
})

test('the price refresh asks openrouter.ai nothing without a key, then once a minute after a key is saved, then hourly', async () => {
  const realFetch = globalThis.fetch
  let priceRequests = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes('openrouter.ai')) priceRequests++
    return new Response(JSON.stringify({ data: [] }))
  }) as typeof fetch
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let keySaved = false
  try {
    startPricingRefresh(() => undefined, () => undefined, () => keySaved)
    mock.timers.tick(10 * 60_000)
    assert.equal(priceRequests, 0, 'ten minutes without a key: nothing fetched')

    keySaved = true
    mock.timers.tick(60_000)
    assert.equal(priceRequests, 1, 'within a minute of the key being saved')
    mock.timers.tick(30 * 60_000)
    assert.equal(priceRequests, 1, 'not again within the hour')
    mock.timers.tick(32 * 60_000)
    assert.equal(priceRequests, 2, 'again after an hour')

    keySaved = false
    mock.timers.tick(3 * 60 * 60_000)
    assert.equal(priceRequests, 2, 'key removed: nothing more fetched')
  } finally {
    mock.timers.reset()
    globalThis.fetch = realFetch
  }
})
