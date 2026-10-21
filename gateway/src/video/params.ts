// Checks the values the page or Dave sends for a video recipe against what the recipe declares.
// Drafted by the local worker (task-004) and reviewed by Claude.

import type { RecipeParams, ParamResult } from './recipe-types.js'

const IMAGE_ID = /^[0-9a-f]{32}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if ((code <= 0x1f && ch !== '\n' && ch !== '\t') || code === 0x7f) return true
  }
  return false
}

export function validateParams(spec: RecipeParams, input: unknown): ParamResult {
  if (!isPlainObject(input)) return { ok: false, errors: ['parameters must be an object'] }

  const errors: string[] = []
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) errors.push(`unknown parameter: ${key}`)
  }

  const values: Record<string, string | number> = {}
  for (const [name, entry] of Object.entries(spec)) {
    // Own keys only: a value inherited through the prototype is not something the caller sent.
    let value = Object.prototype.hasOwnProperty.call(input, name) ? input[name] : undefined
    if (value === undefined && 'default' in entry) value = entry.default

    switch (entry.kind) {
      case 'text':
        if (value === undefined) {
          if (entry.required) errors.push(`${name} is required`)
        } else if (typeof value !== 'string') {
          errors.push(`${name} must be text`)
        } else if (entry.required && value.trim() === '') {
          errors.push(`${name} is required`)
        } else if ([...value].length > entry.maxLength) {
          errors.push(`${name} is longer than ${entry.maxLength} characters`)
        } else if (hasControlCharacter(value)) {
          errors.push(`${name} contains a control character`)
        } else {
          values[name] = value
        }
        break

      case 'int':
        if (value === undefined) break
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          errors.push(`${name} must be a whole number`)
        } else if (value < entry.min || value > entry.max) {
          errors.push(`${name} must be between ${entry.min} and ${entry.max}`)
        } else {
          values[name] = value
        }
        break

      case 'choice':
        if (value === undefined) break
        if (typeof value !== 'string' || !entry.options.includes(value)) {
          errors.push(`${name} must be one of: ${entry.options.join(', ')}`)
        } else {
          values[name] = value
        }
        break

      case 'image':
        if (value === undefined) {
          if (entry.required) errors.push(`${name} is required`)
        } else if (typeof value !== 'string' || !IMAGE_ID.test(value)) {
          errors.push(`${name} must be an uploaded image id`)
        } else {
          values[name] = value
        }
        break
    }
  }

  return errors.length === 0 ? { ok: true, values } : { ok: false, errors }
}
