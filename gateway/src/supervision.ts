// Whether this gateway runs under the supervisor mc start uses (cli/supervise.ts), which restarts it.

const parentAtStart = process.ppid

/** The supervisor's pid while it is still this process's parent; null when run any other way or once it has gone. */
export function supervisedBy(): number | null {
  return process.env['MC_SUPERVISED'] === '1' && process.ppid === parentAtStart ? parentAtStart : null
}
