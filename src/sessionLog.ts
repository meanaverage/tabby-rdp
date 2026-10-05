/**
 * A line as a string of its own. V8 keeps a part cut out of a string (a slice, a pattern's match; 13 characters or
 * more) as a view of the string it came from, and joining strings as a list of them: a short line made from a host's
 * answer of megabytes would keep all of it in memory for as long as the line is kept. Joined to a character and cut
 * from it again: V8 copies a joined string's characters into one string before it cuts a part out of it, so the line
 * is a part of that copy, every character as it was, unpaired surrogates included. A copy through UTF-16 and back
 * does the same at several times the cost, which every line logged pays.
 */
function copied (line: string): string {
    return (' ' + line).slice(1)
}

/**
 * A desktop's connection log (DesktopSession.log): what the settings page's Copy log hands out. Much of it is of the
 * remote's making (an RD Gateway's administrator's messages, a server's), which decides how many lines there are and
 * when, for as long as the desktop stays open: kept whole, they could fill Tabby's memory and crash its window. So the
 * log keeps the first lines (how the connection was set up) and the latest ones, with a line between them saying how
 * many were left out, and each line is cut at MAX_LINE characters and kept as a copy of its own (see copied), which
 * the text it was made from doesn't stay in memory with.
 */
export class SessionLog extends Array<string> {
    /** The first lines, kept whatever follows. */
    static readonly FIRST = 200
    /** At least this many of the latest lines are kept (and at most twice as many, see push). */
    static readonly LATEST = 2000
    /** The longest a line is kept. */
    static readonly MAX_LINE = 4096

    /** How many lines were left out so far. */
    private dropped = 0

    // What is made from the log (filter, slice, map) is a plain array.
    static override get [Symbol.species] (): ArrayConstructor {
        return Array
    }

    override push (...lines: string[]): number {
        const { FIRST, LATEST, MAX_LINE } = SessionLog
        super.push(...lines.map(line => typeof line === 'string' ? copied(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line) : line))
        // Once the latest lines are twice as many as are kept, the older half of them goes in one step: each line then
        // costs the same however many come.
        const said = this.dropped ? 1 : 0
        const over = this.length - FIRST - said - LATEST
        if (over >= LATEST) {
            this.dropped += over
            this.splice(FIRST, said + over, `(${this.dropped} lines left out here)`)
        }
        return this.length
    }
}
