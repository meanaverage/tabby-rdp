/**
 * Which terminal pane a remote terminal belongs to: the remote writes `ESC ] 7777 ; probe ; <id> BEL` to that terminal
 * (see NESTED_SSH_SCRIPT in targets.ts), and the pane whose output carries it is the one (desk.ts strips it on the way
 * in, so nothing shows). Exact where a split's panes share a host, and even their size.
 */
const listeners = new Set<(id: string, pane: object) => void>()

/**
 * How many probes probesIn keeps at most. A pane gets one for each `ssh` in the foreground of its terminal there (two
 * with a jump host's); the host, which is given the prefix, could print any number more while its command runs (up to
 * a minute), each one kept until then.
 */
export const MAX_PROBES = 64

/** What follows a probe's prefix and its dash: the number the script gives each `ssh` it finds, from 1. */
const PROBE_NUMBER = /^[1-9][0-9]{0,2}$/

/** Called by desk.ts for each probe in a pane's output. */
export function probeArrived (id: string, pane: object): void {
    listeners.forEach(f => f(id, pane))
}

/**
 * Collects the probes that arrive in `pane` while `during` runs, and briefly after: ids of the form `<prefix>-<n>`, n
 * from 1 to 999, the first MAX_PROBES of them.
 */
export async function probesIn<T> (pane: object, prefix: string, during: () => Promise<T>, settleMs = 400): Promise<{ result: T, ids: Set<string> }> {
    const ids = new Set<string>()
    const start = `${prefix}-`
    const listener = (id: string, where: object) => {
        if (where === pane && ids.size < MAX_PROBES && id.startsWith(start) && PROBE_NUMBER.test(id.slice(start.length))) {
            ids.add(id)
        }
    }
    listeners.add(listener)
    try {
        const result = await during()
        await new Promise(resolve => setTimeout(resolve, settleMs))
        return { result, ids }
    } finally {
        listeners.delete(listener)
    }
}
