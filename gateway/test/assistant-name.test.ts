// Run with: npm test
// The app's labels use the name the person gave the assistant, read from the identity entry.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assistantName, starterIdentity } from '../src/memory/starter-entries.js'

test('the name comes from the identity entry, in the starter and the older markdown form', () => {
  assert.equal(assistantName(starterIdentity('Cherry')), 'Cherry')
  assert.equal(assistantName('# IDENTITY.md - Who Am I?\n\n- **Name:** Dave\n- **Vibe:** Sharp'), 'Dave')
  assert.equal(assistantName('name: Max'), 'Max')
})

test('no identity, or no name line, means Dave', () => {
  assert.equal(assistantName(null), 'Dave')
  assert.equal(assistantName(''), 'Dave')
  assert.equal(assistantName('Role: helper'), 'Dave')
  assert.equal(assistantName('Name:   '), 'Dave')
})

test('a name is cleaned for display: no control characters or emphasis, at most 30 characters', () => {
  assert.equal(assistantName('Name: **Che\u0007rry**'), 'Cherry')
  assert.equal(assistantName(`Name: ${'x'.repeat(50)}`).length, 30)
})
