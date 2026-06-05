/**
 * agents/registry.ts — Agent credentials registry
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Loads all spec files from agents/specs/ at gateway startup. Each spec file
 * uses a YAML-like frontmatter block to declare the agent's role, tier, and
 * allowed tools. After load the registry is read-only — no runtime method
 * can add, remove, or modify any credential.
 *
 * Used by subagent_spawn (Phase 6) to enforce tool boundaries: any tool not
 * in allowedTools is stripped before the worker receives its toolset, and a
 * security warning is written to error_log.
 */

import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// AgentCredential — immutable record for one agent role
// ---------------------------------------------------------------------------

export interface AgentCredential {
  readonly role: string                    // unique identifier, matches spec filename stem
  readonly tier: 1 | 2 | 3                // 1 = personal agent, 2 = orchestrator, 3 = specialist
  readonly allowedTools: ReadonlyArray<string>
  readonly maxIterations: number
  readonly maxCostUsd: number
  readonly timeoutSeconds: number
  readonly redLines: ReadonlyArray<string> // prose constraints — logged on violation, not silently ignored
}

// ---------------------------------------------------------------------------
// Frontmatter parser
//
// Parses the YAML-like block between the opening and closing --- delimiters.
// Supports scalar values (string, number) and indented list items.
//
// Spec file format:
//
//   ---
//   role: orchestrator
//   tier: 2
//   allowed-tools:
//     - subagent_spawn
//     - artifact_write
//   max-iterations: 20
//   max-cost-usd: 5.00
//   timeout-seconds: 600
//   ---
//
// This parser only handles the subset of YAML used in spec files.
// Do not extend it for general YAML — use js-yaml if that becomes necessary.
// ---------------------------------------------------------------------------

interface RawFrontmatter {
  role?: string
  tier?: number
  'allowed-tools'?: string[]
  'max-iterations'?: number
  'max-cost-usd'?: number
  'timeout-seconds'?: number
}

function parseFrontmatter(source: string, fileName: string): RawFrontmatter {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) {
    return {}
  }

  const block = match[1]
  const result: Record<string, unknown> = {}
  let currentListKey: string | null = null

  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()

    // Indented list item — belongs to the key started on the previous line
    const listMatch = line.match(/^\s+-\s+(.+)$/)
    if (listMatch && currentListKey !== null) {
      const arr = result[currentListKey] as string[]
      arr.push(listMatch[1].trim())
      continue
    }

    // key: value  or  key:  (list follows)
    const kvMatch = line.match(/^([\w-]+):\s*(.*)$/)
    if (!kvMatch) {
      currentListKey = null
      continue
    }

    const key = kvMatch[1]
    const val = kvMatch[2].trim()

    if (val === '') {
      // Start of a list block
      currentListKey = key
      result[key] = []
    } else {
      currentListKey = null
      const asNum = Number(val)
      result[key] = Number.isNaN(asNum) ? val : asNum
    }
  }

  // Validate tier immediately — it is the one field with a strict enum
  if ('tier' in result) {
    const t = result['tier']
    if (t !== 1 && t !== 2 && t !== 3) {
      throw new Error(
        `[registry] ${fileName}: invalid tier "${t}" — must be 1, 2, or 3`
      )
    }
  }

  return result as RawFrontmatter
}

// ---------------------------------------------------------------------------
// Red lines extractor
//
// Reads bulleted lines from the ## Red Lines section of the spec markdown.
// Used for logging on policy violation — not enforcement logic.
// ---------------------------------------------------------------------------

function parseRedLines(source: string): string[] {
  const match = source.match(/##\s+Red Lines\s*\r?\n([\s\S]*?)(?=\n##|$)/)
  if (!match) return []

  return match[1]
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private readonly store: ReadonlyMap<string, AgentCredential>

  private constructor(store: Map<string, AgentCredential>) {
    // Freeze every credential and the map itself
    for (const [, cred] of store) {
      Object.freeze(cred)
    }
    this.store = store
  }

  /**
   * Loads all .md spec files from specsDir and returns a populated registry.
   * Throws on duplicate roles or invalid tier values.
   * Returns an empty registry if specsDir does not exist — agents are added
   * incrementally as they are built.
   */
  static loadFromDirectory(specsDir: string): AgentRegistry {
    const store = new Map<string, AgentCredential>()

    if (!fs.existsSync(specsDir)) {
      console.log(`[registry] specs dir not found at ${specsDir} — starting with empty registry`)
      return new AgentRegistry(store)
    }

    const files = fs.readdirSync(specsDir).filter((f) => f.endsWith('.md'))

    if (files.length === 0) {
      console.log(`[registry] no spec files found in ${specsDir} — starting with empty registry`)
      return new AgentRegistry(store)
    }

    for (const file of files) {
      const filePath = path.join(specsDir, file)
      const source = fs.readFileSync(filePath, 'utf-8')
      const raw = parseFrontmatter(source, file)

      if (!raw.role) {
        // Non-fatal — a spec in progress may not have frontmatter yet
        console.warn(`[registry] skipping ${file} — no 'role' field in frontmatter`)
        continue
      }

      if (store.has(raw.role)) {
        throw new Error(
          `[registry] duplicate role "${raw.role}" — ${file} conflicts with an already-loaded spec`
        )
      }

      // tier was validated inside parseFrontmatter
      const tier = (raw.tier ?? 3) as 1 | 2 | 3

      const credential: AgentCredential = {
        role: raw.role,
        tier,
        allowedTools: Object.freeze(raw['allowed-tools']?.slice() ?? []),
        maxIterations: raw['max-iterations'] ?? 20,
        maxCostUsd: raw['max-cost-usd'] ?? 1.0,
        timeoutSeconds: raw['timeout-seconds'] ?? 120,
        redLines: Object.freeze(parseRedLines(source)),
      }

      store.set(raw.role, credential)
      console.log(
        `[registry] loaded role "${raw.role}" (tier ${tier}, ${credential.allowedTools.length} tools)`
      )
    }

    return new AgentRegistry(store)
  }

  // ---------------------------------------------------------------------------
  // Query methods — all read-only
  // ---------------------------------------------------------------------------

  /** Returns the credential for a role, or undefined if the role is unknown. */
  get(role: string): AgentCredential | undefined {
    return this.store.get(role)
  }

  /** Returns true if the role exists and is permitted to call the named tool. */
  hasCapability(role: string, tool: string): boolean {
    return this.store.get(role)?.allowedTools.includes(tool) ?? false
  }

  /**
   * Splits requestedTools into allowed and stripped subsets for a given role.
   *
   * Used by subagent_spawn before handing a toolset to a worker:
   *   const { allowed, stripped } = registry.filterTools(role, requestedTools)
   *   if (stripped.length > 0) writeSecurityWarningToErrorLog(role, stripped)
   *   worker.tools = allowed
   *
   * If the role is unknown every tool is stripped — unknown roles get nothing.
   */
  filterTools(
    role: string,
    requestedTools: string[]
  ): { allowed: string[]; stripped: string[] } {
    const credential = this.store.get(role)

    if (!credential) {
      return { allowed: [], stripped: requestedTools.slice() }
    }

    const allowed: string[] = []
    const stripped: string[] = []

    for (const tool of requestedTools) {
      if (credential.allowedTools.includes(tool)) {
        allowed.push(tool)
      } else {
        stripped.push(tool)
      }
    }

    return { allowed, stripped }
  }

  /** Returns all loaded role names. */
  roles(): string[] {
    return Array.from(this.store.keys())
  }

  /** Returns the number of loaded credentials. */
  get size(): number {
    return this.store.size
  }
}
