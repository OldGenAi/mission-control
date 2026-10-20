// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderRegistry } from '../src/providers/registry.js'
import { UnconfiguredProvider, resolveBootProvider } from '../src/providers/unconfigured.js'
import type { SettingsSnapshot } from '../src/store/settings.js'
import type { StreamChunk } from '../src/providers/types.js'

// Only the fields the registry reads.
const settings = (openrouterKey: string) =>
  ({ localProviderUrl: 'http://127.0.0.1:1234/v1', providerKeys: { openrouter: openrouterKey, anthropic: '' } }) as unknown as SettingsSnapshot

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

test('without a key the boot provider is a stand-in, so the gateway can still start', () => {
  const registry = new ProviderRegistry(settings(''))
  assert.equal(registry.get('openrouter'), null)
  const boot = resolveBootProvider(registry, 'openrouter')
  assert.equal(boot.configured, false)
  assert.ok(boot.provider instanceof UnconfiguredProvider)
})

test('the stand-in ends every request with one done chunk that says how to fix it, and never throws', async () => {
  const chunks = await collect(new UnconfiguredProvider('openrouter').complete())
  assert.equal(chunks.length, 1)
  const done = chunks[0]
  assert.equal(done?.type, 'done')
  assert.ok(done?.type === 'done' && done.error)
  assert.match((done as { error: string }).error, /OpenRouter key/)
  assert.match((done as { error: string }).error, /Settings/)
  assert.deepEqual((done as { usage: unknown }).usage, { inputTokens: 0, outputTokens: 0 })
})

test('with a key the real provider is used', () => {
  const registry = new ProviderRegistry(settings('sk-or-v1-test'))
  const boot = resolveBootProvider(registry, 'openrouter')
  assert.equal(boot.configured, true)
  assert.equal(boot.provider.name, 'openrouter')
})

test('the local provider is always available, so a local setup starts without any key', () => {
  const boot = resolveBootProvider(new ProviderRegistry(settings('')), 'local')
  assert.equal(boot.configured, true)
})

test('once a key is saved the registry hands out the real provider on the next lookup', () => {
  const registry = new ProviderRegistry(settings(''))
  assert.equal(registry.get('openrouter'), null)
  registry.rebuild(settings('sk-or-v1-test'))   // what the settings subscription does when the UI saves a key
  assert.equal(registry.get('openrouter')?.name, 'openrouter')
})
