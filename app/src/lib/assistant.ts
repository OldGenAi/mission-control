import { useEffect, useState } from "react"
import { gateway } from "./gateway-client"

// The name the person gave their assistant (the welcome form, or the identity entry on the
// Agents page), and the person's own name from their user entry. Asked once per page load and
// shared by every label that shows them.
const DEFAULT_NAME = "Dave"

interface Names { name: string; personName: string }
let cached: Names | null = null
let pending: Promise<Names> | null = null

function loadNames(): Promise<Names> {
  if (cached) return Promise.resolve(cached)
  pending ??= gateway.request<{ name?: string; personName?: string }>("assistant.name", {})
    .then((r) => (cached = { name: r.name?.trim() || DEFAULT_NAME, personName: r.personName?.trim() ?? "" }))
    .catch(() => ({ name: DEFAULT_NAME, personName: "" })) // an older gateway, or not connected yet: the defaults are fine for a label
    .finally(() => { pending = null })
  return pending
}

function useNames(): Names {
  const [names, setNames] = useState(cached ?? { name: DEFAULT_NAME, personName: "" })
  useEffect(() => {
    let alive = true
    void loadNames().then((n) => { if (alive) setNames(n) })
    return () => { alive = false }
  }, [])
  return names
}

export function useAssistantName(): string {
  return useNames().name
}

/** The person's own name, or "" when their user entry has no "Name:" line. */
export function usePersonName(): string {
  return useNames().personName
}

/** Up to two initials for an avatar: "Rodney" -> "R", "John Brown" -> "JB", "JB" -> "JB". */
export function initials(name: string, fallback: string): string {
  const words = name.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (words.length === 0) return fallback
  if (words.length === 1) {
    const w = words[0]!
    return w.length <= 2 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase()
  }
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase()
}
