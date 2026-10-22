// mc doctor's ComfyUI check. ComfyUI is only needed for the Video page, so "not running" is
// information, not a problem. When it is running, the checks match the Video page's warnings.

import type { DoctorCheck } from './report-types.js'
import { ComfyClient, checkComfyUrl, listensBeyondThisComputer } from '../video/comfyui.js'

export async function comfyChecks(address = 'http://127.0.0.1:8188'): Promise<DoctorCheck[]> {
  const checked = checkComfyUrl(address)
  if ('error' in checked) {
    return [{ name: 'ComfyUI', status: 'warn', detail: checked.error, fix: 'Set the ComfyUI address on the Video page, like http://127.0.0.1:8188' }]
  }
  let stats
  try {
    stats = await new ComfyClient(checked.url).stats()
  } catch {
    stats = null // not running, or not ComfyUI: reported below the same way
  }
  if (!stats) return [{ name: 'ComfyUI', status: 'info', detail: `not answering at ${address} (only needed for the Video page)` }]

  const checks: DoctorCheck[] = [{ name: 'ComfyUI', status: 'ok', detail: `version ${stats.version} at ${address}${stats.device ? `, ${stats.device.name}` : ''}` }]
  if (listensBeyondThisComputer(stats.argv)) {
    checks.push({ name: 'ComfyUI', status: 'warn', detail: 'started with --listen, so other devices can reach it (ComfyUI has no sign-in)', fix: 'Start ComfyUI without --listen' })
  }
  if (!stats.argv.includes('--disable-metadata')) {
    checks.push({ name: 'ComfyUI', status: 'info', detail: 'saves your prompt inside the files it makes (Mission Control removes it from its own copies)', fix: 'Start ComfyUI with --disable-metadata' })
  }
  return checks
}
