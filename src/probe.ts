/**
 * Which terminal pane a remote terminal belongs to: the remote writes `ESC ] 7777 ; probe ; <id> BEL` to that terminal
 * (see NESTED_SSH_SCRIPT in targets.ts), and the pane whose output carries it is the one (desk.ts strips it on the way
 * in, so nothing shows). Exact where a split's panes share a host, and even their size.
 */
const listeners = new Set<(id: string, pane: object) => void>()

/** Called by desk.ts for each probe in a pane's output. */
export function probeArrived (id: string, pane: object): void {
    listeners.forEach(f => f(id, pane))
}

/** Collects the probes (ids starting with `prefix`) that arrive in `pane` while `during` runs, and briefly after. */
export async function probesIn<T> (pane: object, prefix: string, during: () => Promise<T>, settleMs = 400): Promise<{ result: T, ids: Set<string> }> {
    const ids = new Set<string>()
    const listener = (id: string, where: object) => {
        if (where === pane && id.startsWith(prefix)) {
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
