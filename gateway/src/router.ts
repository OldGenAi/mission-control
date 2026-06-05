import type { MethodHandler, ConnectedClient } from './types.js'

const handlers = new Map<string, MethodHandler>()

/**
 * Register a handler for a method name
 * Called once at startup for each supported method
 */
export function registerMethod(method: string, handler: MethodHandler): void {
  handlers.set(method, handler)
}

/**
 * Dispatch a request to its registered handler
 * Returns the handler's result payload, or throws if method not found
 * Throws an object with { code: 'METHOD_NOT_FOUND', message: string } if not registered
 */
export async function dispatch(
  method: string,
  params: Record<string, unknown>,
  client: ConnectedClient
): Promise<Record<string, unknown>> {
  const handler = handlers.get(method)

  if (!handler) {
    throw {
      code: 'METHOD_NOT_FOUND',
      message: `Unknown method: ${method}`,
    }
  }

  return await handler(params, client)
}

/**
 * Return a list of all registered method names (used by the health and connect handlers)
 */
export function listMethods(): string[] {
  return Array.from(handlers.keys())
}
