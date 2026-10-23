// The Health page's buttons: doctor.status / doctor.check / doctor.fix / doctor.fixSafe / doctor.ignore / doctor.history.
// Only the signed-in app can call these; agents have no tool for them.

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

export function registerDoctorMethods(doctor: DoctorHandle): void {
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
