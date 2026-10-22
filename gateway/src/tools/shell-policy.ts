/**
 * tools/shell-policy.ts — whether the shell tool (exec) may run at all
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * The exec tool runs commands with the user's full rights: nothing confines a command to the
 * workspace. Until Mission Control has a sandbox for commands (the "locked room": MXC on
 * Windows, the network jail / srt elsewhere), the shell stays locked for everyone. The setting
 * alone is not enough to turn it on.
 *
 * MC_ALLOW_UNSANDBOXED_SHELL=1 is a deliberate escape hatch for developers who accept the risk
 * on their own machine. It is read from the gateway's environment, never from settings the UI
 * or an agent can change.
 */

export interface ShellAvailability {
  available: boolean
  reason: string
}

export function shellAvailability(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ShellAvailability {
  if (env['MC_ALLOW_UNSANDBOXED_SHELL'] === '1') {
    return { available: true, reason: 'Unlocked by MC_ALLOW_UNSANDBOXED_SHELL=1. Commands are not sandboxed.' }
  }
  if (platform === 'win32') {
    return { available: false, reason: 'Mission Control is running directly on Windows, where the shell tool cannot run yet.' }
  }
  return { available: false, reason: 'Mission Control has no safe sandbox for commands yet, so the shell tool stays locked.' }
}

/** The shell is on only when the user switched it on AND it is allowed to run here. */
export function execAllowed(execEnabled: boolean, availability: ShellAvailability = shellAvailability()): boolean {
  return execEnabled && availability.available
}
