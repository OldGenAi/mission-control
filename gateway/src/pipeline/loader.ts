import { readFileSync } from 'node:fs'
import { load as loadYaml } from 'js-yaml'
import type { PipelineDefinition, StepType } from './types.js'

export function loadPipeline(filePath: string): PipelineDefinition {
  const content = readFileSync(filePath, 'utf-8')
  let parsed: unknown

  if (filePath.endsWith('.json')) {
    parsed = JSON.parse(content)
  } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    parsed = loadYaml(content)
  } else {
    throw new Error('unsupported file type — must be .yaml, .yml, or .json')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid pipeline format')
  }

  const obj = parsed as Record<string, unknown>

  if (typeof obj.id !== 'string') throw new Error('missing or invalid id')
  if (typeof obj.name !== 'string') throw new Error('missing or invalid name')
  if (typeof obj.version !== 'string') throw new Error('missing or invalid version')
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error('steps must be a non-empty array')
  }

  const validTypes: StepType[] = ['llm', 'spawn_agent', 'approval_gate', 'condition', 'parallel']

  for (let i = 0; i < obj.steps.length; i++) {
    const step = obj.steps[i]
    if (!step || typeof step !== 'object') {
      throw new Error(`step ${i}: invalid format`)
    }
    if (typeof step.id !== 'string') throw new Error(`step ${i}: missing or invalid id`)
    if (!validTypes.includes(step.type as StepType)) {
      throw new Error(`step ${i}: invalid type "${step.type}"`)
    }
  }

  return obj as unknown as PipelineDefinition

}
