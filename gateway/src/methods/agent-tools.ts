/**
 * methods/agent-tools.ts — agent.tools.set / agent.tools.get
 *
 * Lets the UI push a per-agent enabled-tool list to the gateway.
 * The AgentLoop reads toolOverrides on every turn — disabling a tool
 * takes effect on the next message sent.
 */

import { registerMethod } from '../router.js'
import { toolOverrides } from '../store/tool-overrides.js'

export function registerAgentToolsMethods(): void {
  // agent.tools.set — set the enabled tool list for an agent
  // Pass enabledTools: null to restore "all credentialed tools" default.
  registerMethod('agent.tools.set', async (params) => {
    const { agentId, enabledTools } = params as {
      agentId: string
      enabledTools: string[] | null
    }
    if (!agentId) return { error: 'agentId is required' }

    if (enabledTools === null) {
      toolOverrides.delete(agentId)
    } else {
      if (!Array.isArray(enabledTools)) return { error: 'enabledTools must be an array or null' }
      toolOverrides.set(agentId, new Set(enabledTools))
    }

    return { ok: true, agentId, active: enabledTools?.length ?? 'all' }
  })

  // agent.tools.get — read current override for an agent
  registerMethod('agent.tools.get', async (params) => {
    const { agentId } = params as { agentId: string }
    if (!agentId) return { error: 'agentId is required' }

    const override = toolOverrides.get(agentId)
    return {
      agentId,
      enabledTools: override ? [...override] : null,
      // null means "no override — all credentialed tools active"
    }
  })
}
