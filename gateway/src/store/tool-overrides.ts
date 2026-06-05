/**
 * store/tool-overrides.ts — in-memory per-agent tool enable set
 *
 * null (key absent) = use all credentialed tools from the registry (default).
 * Set present       = only those tools are offered to the model this turn.
 *
 * Written by agent.tools.set, read by AgentLoop on every turn.
 * Resets to null on gateway restart — UI re-pushes saved config on reconnect.
 */

export const toolOverrides = new Map<string, Set<string>>()
