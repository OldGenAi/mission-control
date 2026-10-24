// doctor_status: lets the assistant read the doctor's latest findings when the person asks how Mission Control is doing.
// Read-only on purpose: fixing, ignoring and restarting stay on the Health page, where the person approves them.

import type { DoctorEngine } from '../doctor/engine.js'
import { redact } from '../store/redact.js'
import type { RegisteredTool, ToolContext, ToolResult } from './types.js'

export function makeDoctorStatusTool(engine: DoctorEngine): RegisteredTool {
  return {
    schema: {
      name: 'doctor_status',
      description:
        'Read the Mission Control doctor: the result of its latest health checks, any issues it found and what the person can do about them. Use this when the person asks how Mission Control is doing or asks you to check the doctor. One call is enough. It cannot fix anything: fixes are on the Health page.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now()
      const status = engine.status()
      const report = {
        overall: status.overall,
        checkedAt: status.checkedAt ? new Date(status.checkedAt).toISOString() : null,
        issues: status.issues.map((issue) => ({
          title: issue.title,
          status: issue.status,
          summary: issue.summary,
          ...(issue.why ? { why: issue.why } : {}),
          ...(issue.steps ? { steps: issue.steps } : {}),
          ...(issue.fix ? { fixOnHealthPage: issue.fix.label } : {}),
        })),
        ignoredByPerson: status.ignored.map((issue) => issue.title),
        passed: status.passed.map((check) => `${check.title}: ${check.summary}`),
      }
      return { correlationId: ctx.correlationId, toolName: 'doctor_status', status: 'ok', output: redact(JSON.stringify(report)), durationMs: Date.now() - start }
    },
  }
}
