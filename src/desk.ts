import { Injectable, NgZone } from '@angular/core'
import { NotificationsService } from 'tabby-core'
import { BaseTerminalTabComponent, SessionMiddleware, TerminalDecorator } from 'tabby-terminal'
import { RemoteDesktopService } from './desktop.service'
import { desktopPaneOf } from './targets'
import { DeskRequest } from './deskScript'

const PREFIX = Buffer.from('\x1b]7777;desk;')
const BEL = 0x07
const ST = Buffer.from('\x1b\\')

function parse (payload: string): DeskRequest {
    const [session, socket, cwd, kind] = payload.split(';').map(f => Buffer.from(f ?? '', 'base64').toString('utf8'))
    // Older `desk` scripts sent no kind: they only knew tmux.
    return { session: session ?? '', socket: socket ?? '', cwd: cwd ?? '', kind: kind ?? (session ? 'tmux' : '') }
}

/** Strips `desk` requests out of a session's output and reports them. */
class DeskTrigger extends SessionMiddleware {
    constructor (private onDesk: (request: DeskRequest) => void) {
        super()
    }

    override feedFromSession (data: Buffer): void {
        // Tabby's OSC processor runs first and passes unknown OSCs through whole, so each request
        // arrives complete within one chunk.
        let start = data.indexOf(PREFIX)
        while (start !== -1) {
            const body = start + PREFIX.length
            const bel = data.indexOf(BEL, body)
            const st = data.indexOf(ST, body)
            const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
            if (end === -1) {
                break
            }
            const request = parse(data.subarray(body, end).toString('utf8'))
            data = Buffer.concat([data.subarray(0, start), data.subarray(end + (end === st ? ST.length : 1))])
            setTimeout(() => this.onDesk(request))
            start = data.indexOf(PREFIX, start)
        }
        if (data.length) {
            super.feedFromSession(data)
        }
    }
}

/** Listens for `desk` in every terminal (SSH tabs and local terminals running ssh). */
@Injectable()
export class DeskTriggerDecorator extends TerminalDecorator {
    constructor (private desktop: RemoteDesktopService, private zone: NgZone, private notifications: NotificationsService) {
        super()
    }

    override attach (terminal: BaseTerminalTabComponent<any>): void {
        const install = () => {
            terminal.session?.middleware.push(new DeskTrigger(request => this.zone.run(() => {
                const pane = desktopPaneOf(terminal)
                if (!pane) {
                    return
                }
                if (!this.desktop.settings().desk) {
                    // A hook left from when it was on; it goes away the next time a desktop opens there.
                    this.notifications.info('`desk` is off: turn it on in the menu under Remote Desktop › Settings')
                    return
                }
                this.desktop.openConsole(pane, request)
            })))
        }
        install()
        this.subscribeUntilDetached(terminal, terminal.sessionChanged$.subscribe(() => install()))
    }
}
