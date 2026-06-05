import type Database from 'better-sqlite3'

interface SweepRow { id: string; agent_id: string; key: string }

const DAILY_NOTE_KEY = /^\d{4}-\d{2}-\d{2}$/
const SEVEN_DAYS_MS  = 7 * 24 * 60 * 60 * 1000
const HOURLY_MS      = 60 * 60 * 1000

export function startDailyNoteSweep(
  db: Database.Database,
  intervalMs = HOURLY_MS,
): () => void {
  const findStmt = db.prepare<[number], SweepRow>(
    `SELECT id, agent_id, key FROM memory_entries
     WHERE valid_until IS NULL
       AND type != 'milestone'
       AND valid_from < ?
       AND key GLOB '????-??-??'`,
  )
  const expireStmt = db.prepare(
    `UPDATE memory_entries SET valid_until = ? WHERE id = ?`,
  )

  function tick(): void {
    try {
      const now    = Date.now()
      const cutoff = now - SEVEN_DAYS_MS
      const cid    = `sweep-${now}`
      const rows   = findStmt.all(cutoff).filter(r => DAILY_NOTE_KEY.test(r.key))
      if (rows.length === 0) return

      const expire = db.transaction((batch: SweepRow[]) => {
        for (const row of batch) expireStmt.run(now, row.id)
      })
      expire(rows)

      console.log(`[sweep] cid=${cid} expired ${rows.length} daily note(s) older than 7 days`)
    } catch (e) {
      console.error('[sweep] tick failed:', e instanceof Error ? e.message : e)
    }
  }

  tick()
  const handle = setInterval(tick, intervalMs)
  return () => clearInterval(handle)
}
