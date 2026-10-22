import { useEffect, useState } from "react"
import { gateway } from "./gateway-client"

// The name the person gave their assistant (the welcome form, or the identity entry on the
// Agents page). Asked once per page load and shared by every label that shows it.
const DEFAULT_NAME = "Dave"
let cached: string | null = null
let pending: Promise<string> | null = null

function loadName(): Promise<string> {
  if (cached) return Promise.resolve(cached)
  pending ??= gateway.request<{ name?: string }>("assistant.name", {})
    .then((r) => (cached = r.name?.trim() || DEFAULT_NAME))
    .catch(() => DEFAULT_NAME) // an older gateway, or not connected yet: the default is fine for a label
    .finally(() => { pending = null })
  return pending
}

export function useAssistantName(): string {
  const [name, setName] = useState(cached ?? DEFAULT_NAME)
  useEffect(() => {
    let alive = true
    void loadName().then((n) => { if (alive) setName(n) })
    return () => { alive = false }
  }, [])
  return name
}
