import type { MethodHandler } from '../types.js'
import { registerMethod } from '../router.js'
import type { RegisteredTool } from '../tools/types.js'

export function registerToolsMethods(tools: Map<string, RegisteredTool>): void {
  const listTools: MethodHandler = async () => {
    // Expose requiresExplicitEnable (true for exec) alongside the schema so the UI
    // can flag/lock tools that need the global shell-access switch. The schema by
    // itself (name/description/parameters) omits it.
    const toolList = Array.from(tools.values()).map((tool) => ({
      ...tool.schema,
      requiresExplicitEnable: tool.requiresExplicitEnable ?? false,
    }))
    return { tools: toolList }
  }

  registerMethod('tools.list', listTools)
}
