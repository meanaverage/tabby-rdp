import { Injectable, NgZone } from '@angular/core'
import { BaseTerminalTabComponent, SessionMiddleware, TerminalDecorator } from 'tabby-terminal'
import { RemoteDesktopService } from './desktop.service'
import { desktopPaneOf } from './targets'
import { DeskRequest, DeskRequests } from './deskScript'
import { probeArrived } from './probe'

/** Strips `desk` requests (and probes, see probe.ts) out of a session's output and reports them. */
class DeskTrigger extends SessionMiddleware {
    private requests: DeskRequests

    constructor (known: (key: string) => boolean, private onDesk: (request: DeskRequest) => void, private onProbe: (id: string) => void) {
        super()
        this.requests = new DeskRequests(known)
    }

    override feedFromSession (data: Buffer): void {
        // Tabby's OSC processor runs first and passes unknown OSCs through whole, so each request
        // arrives complete within one chunk.
        const { output, desk, probes } = this.requests.take(data)
        probes.forEach(id => this.onProbe(id))
        if (desk) {
            setTimeout(() => this.onDesk(desk))
        }
        if (output.length) {
            super.feedFromSession(output)
        }
    }
}

/** Listens for `desk` in every terminal (SSH tabs and local terminals running ssh). */
@Injectable()
export class DeskTriggerDecorator extends TerminalDecorator {
    constructor (private desktop: RemoteDesktopService, private zone: NgZone) {
        super()
    }

    override attach (terminal: BaseTerminalTabComponent<any>): void {
        const install = () => {
            // Only requests with a key a host gave get this far, one in a while (see DeskRequests); the service checks
            // the rest, the `desk` setting included.
            terminal.session?.middleware.push(new DeskTrigger(key => this.desktop.knowsDeskKey(key), request => this.zone.run(() => {
                const pane = desktopPaneOf(terminal)
                if (pane) {
                    this.desktop.openConsole(pane, request)
                }
            }), id => probeArrived(id, terminal)))
        }
        install()
        this.subscribeUntilDetached(terminal, terminal.sessionChanged$.subscribe(() => install()))
    }
}
