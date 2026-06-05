import { registerMethod } from '../router.js'
import type { AgentRegistry } from '../agents/registry.js'

export function registerAgentsMethods(registry: AgentRegistry): void {
  registerMethod('agents.list', async (_params, _client) => {
    const agents = registry.roles().map((role) => {
      const cred = registry.get(role)!
      return {
        role: cred.role,
        tier: cred.tier,
        allowedTools: [...cred.allowedTools],
        maxIterations: cred.maxIterations,
        maxCostUsd: cred.maxCostUsd,
        timeoutSeconds: cred.timeoutSeconds,
      }
    })
    return { agents }
  })
}
