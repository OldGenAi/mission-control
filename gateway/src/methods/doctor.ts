// The Health page's buttons: doctor.status / doctor.check / doctor.fix / doctor.fixSafe / doctor.ignore / doctor.history /
// doctor.restart.
// Only the signed-in app can call these. Agents can only read the doctor's status (tools/doctor.ts); every change stays here.

import { registerMethod } from '../router.js'
import { DoctorError } from '../doctor/engine.js'
import type { DoctorHandle } from '../doctor/index.js'

function checkIdFrom(params: Record<string, unknown>): string {
  const id = params['checkId']
  if (typeof id !== 'string' || !/^[a-z_.]{1,64}$/.test(id)) throw { code: 'INVALID_PARAMS', message: 'checkId is required' }
  return id
}

async function answer(work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof DoctorError) return { ok: false, code: err.code, error: err.message }
    throw err
  }
}

/** restart: stops the gateway cleanly so its supervisor starts it again; null when nothing would start it again. */
export function registerDoctorMethods(doctor: DoctorHandle, restart: (() => void) | null): void {
  registerMethod('doctor.restart', async () => {
    if (!restart) {
      return {
        ok: false, code: 'NO_SUPERVISOR',
        error: 'Mission Control was not started with Start Mission Control or mc start, so it can\'t restart itself. Stop it and start it again the way you started it.',
      }
    }
    const busy = doctor.busy()
    if (busy.length > 0) return { ok: false, code: 'BUSY', error: `Not now: ${busy.join(', ')}. Restart when it has finished.` }
    doctor.engine.record('restarting', 'restarting Mission Control (Restart button)')
    setTimeout(restart, 300).unref()   // answer the page first
    return { ok: true }
  })

  registerMethod('doctor.status', async (params) => {
    if (typeof params['appVersion'] === 'string') doctor.setAppVersion(params['appVersion'])
    return { ok: true, ...doctor.engine.status() }
  })

  registerMethod('doctor.check', async () => {
    await doctor.engine.sweep(true)
    return { ok: true, ...doctor.engine.status() }
  })

  registerMethod('doctor.fix', (params) => answer(async () => {
    const note = await doctor.engine.fix(checkIdFrom(params), params['confirmed'] === true)
    return { ok: true, note, ...doctor.engine.status() }
  }))

  registerMethod('doctor.fixSafe', () => answer(async () => {
    const result = await doctor.engine.fixAllSafe()
    return { ok: true, ...result, ...doctor.engine.status() }
  }))

  registerMethod('doctor.ignore', (params) => answer(async () => {
    doctor.engine.ignore(checkIdFrom(params), params['ignore'] !== false)
    return { ok: true, ...doctor.engine.status() }
  }))

  registerMethod('doctor.history', async (params) => {
    const limit = typeof params['limit'] === 'number' ? params['limit'] : 100
    return { ok: true, events: doctor.engine.history(limit) }
  })
}
