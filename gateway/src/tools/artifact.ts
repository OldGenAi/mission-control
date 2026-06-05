/**
 * tools/artifact.ts — artifact_write
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Artifacts are the typed outputs workers produce and hand off between
 * pipeline steps. Every artifact is stored in SQLite — never deleted.
 * artifact_write is available to all agents.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'

// ---------------------------------------------------------------------------
// Valid artifact types — must match the artifacts table CHECK constraint
// ---------------------------------------------------------------------------

const ARTIFACT_TYPES = ['plan', 'code', 'review', 'report', 'data'] as const
type ArtifactType = typeof ARTIFACT_TYPES[number]

function isArtifactType(v: unknown): v is ArtifactType {
  return ARTIFACT_TYPES.includes(v as ArtifactType)
}

// Derive a sensible title from the artifact body when the model omits one.
// First non-empty line, stripped of leading markdown heading/emphasis marks,
// capped; falls back to "<type> artifact" if the content is title-less.
function deriveTitle(content: string, type: ArtifactType): string {
  const firstLine = content.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (firstLine) {
    const cleaned = firstLine.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim()
    if (cleaned) return cleaned.slice(0, 80)
  }
  return `${type} artifact`
}

// ---------------------------------------------------------------------------
// Factory — takes a db reference so the tool closes over a live connection
// ---------------------------------------------------------------------------

export function makeArtifactWrite(db: Database.Database): RegisteredTool {
  const insert = db.prepare(`
    INSERT INTO artifacts (id, type, title, content, agent_id, session_id, pipeline_run_id, step_id, created_at)
    VALUES (@id, @type, @title, @content, @agentId, @sessionId, @pipelineRunId, @stepId, @createdAt)
  `)

  return {
    schema: {
      name: 'artifact_write',
      description: 'Store a typed artifact in the Mission Control artifact store. Returns the artifact ID. Artifacts are permanent — they cannot be deleted.',
      parameters: {
        type: 'object',
        required: ['type', 'title', 'content'],
        properties: {
          type: {
            type: 'string',
            enum: [...ARTIFACT_TYPES],
            description: 'Artifact type: plan, code, review, report, or data.',
          },
          title: {
            type: 'string',
            description: 'Short human-readable title for the artifact.',
          },
          content: {
            type: 'string',
            description: 'Full artifact content as plain text or Markdown. Write it directly — do NOT wrap it in quotes or embed a JSON object inside this field.',
          },
          pipelineRunId: {
            type: 'string',
            description: 'Pipeline run ID this artifact belongs to, if applicable.',
          },
          stepId: {
            type: 'string',
            description: 'Pipeline step ID this artifact was produced by, if applicable.',
          },
        },
      },
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const start = Date.now()

      // Robustness: small local models routinely omit or mistype the `type`
      // field (Gemma's most common artifact_write failure). Default to 'report'
      // when missing/invalid and warn — the alternative is silent pipeline
      // failure with no deliverable. Workers that genuinely need 'code' /
      // 'plan' / etc. must pass them explicitly; their specs already say so.
      let artifactType: ArtifactType
      if (isArtifactType(args['type'])) {
        artifactType = args['type']
      } else {
        artifactType = 'report'
        console.warn(`[artifact_write] cid=${context.correlationId} agent=${context.agentId} missing/invalid type "${args['type']}" — defaulting to "report"`)
      }

      const content = args['content']
      if (typeof content !== 'string') {
        return { correlationId: context.correlationId, toolName: 'artifact_write', status: 'error', output: '', error: 'content must be a string', durationMs: Date.now() - start }
      }

      // Robustness (same rationale as `type` above): models — Qwen especially — sometimes
      // omit `title` on the first call. That used to hard-fail and force a wasted retry (or
      // lose the deliverable). Derive a title from the content's first line instead, and warn.
      let title: string
      if (typeof args['title'] === 'string' && args['title'].trim()) {
        title = args['title'].trim()
      } else {
        title = deriveTitle(content, artifactType)
        console.warn(`[artifact_write] cid=${context.correlationId} agent=${context.agentId} missing/empty title — derived "${title}"`)
      }

      const id = randomUUID()

      try {
        // Pipeline linkage: context wins over args. The runner injects pipelineRunId
        // and stepId via ToolContext when the worker is running inside a pipeline,
        // so the worker doesn't need to know (and can't, really) the run ID. Args
        // remain as a fallback for callers that do know it (e.g. tests).
        const pipelineRunId = context.pipelineRunId
          ?? (typeof args['pipelineRunId'] === 'string' ? args['pipelineRunId'] : null)
        const stepId = context.stepId
          ?? (typeof args['stepId'] === 'string' ? args['stepId'] : null)

        insert.run({
          id,
          type: artifactType,
          title,
          content,
          agentId: context.agentId,
          sessionId: context.sessionId ?? null,
          pipelineRunId,
          stepId,
          createdAt: Date.now(),
        })

        return {
          correlationId: context.correlationId,
          toolName: 'artifact_write',
          status: 'ok',
          output: JSON.stringify({ id, type: artifactType, title }),
          durationMs: Date.now() - start,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { correlationId: context.correlationId, toolName: 'artifact_write', status: 'error', output: '', error: msg, durationMs: Date.now() - start }
      }
    },
  }
}
