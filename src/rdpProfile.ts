import { Component, ElementRef, Injectable, Injector, NgZone, OnInit, ViewEncapsulation } from '@angular/core'
import {
    BaseTabComponent, Command, CommandProvider, ConfigService, ConnectableProfile, NewTabParameters, PartialProfile,
    ProfileSettingsComponent, ProfilesService, QuickConnectProfileProvider, RecoveryToken, TabRecoveryProvider,
} from 'tabby-core'
import { BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'
import { RemoteDesktopService } from './desktop.service'
import { formatAddress, parseAddress } from './desktopForm'
import { RemoteDesktopHelp } from './help'
import { ASK_GATEWAY_ACCOUNT, signInName } from './accounts'
import { newAccountOption } from './accountForm'
import { CLIPBOARD_LABELS, ClipboardMode, ownClipboard } from './clipboard'
import { configText, desktopIdOf } from './desktops'
import { parseGateway } from './gateway'
import { configNumber } from './osd'
import { isConnected, isSSHTab } from './ssh'
import { RDP_PROFILE_TYPE, RemoteTargets } from './targets'

/**
 * A "Remote desktop (RDP)" profile: an RDP server this computer reaches directly (LAN, VPN), opened in a tab of its
 * own that the desktop fills; or, with `via`, one behind an SSH profile's host, opened over that profile's SSH tab.
 */
export interface RDPProfile extends ConnectableProfile {
    options: {
        /** The RDP server: as this computer sees it, or as the `via` host sees it. */
        host: string
        port: number
        /** Or null: Windows whatever the defaults say (an imported profile's, see RemoteDesktopService.importRdp). */
        kind: 'windows' | 'gnome' | 'xrdp' | null
        /** Optional; the sign-in form asks. DOMAIN\user works too. */
        username: string
        domain: string
        /**
         * A saved account's id (see accounts.ts) to sign in with, in place of the user name and domain; or '' (the
         * group's or the global default's, else none), or null: none whatever the defaults (an imported profile's).
         */
        account: string | null
        /** An SSH profile's id to go through, or '' to connect directly. */
        via: string
        /** An RD Gateway's address (`host` or `host:port`) to reach the server through, or ''; `host` is then as the gateway sees it. */
        gateway: string
        /**
         * A saved account's id to sign in to the gateway with, or '' for the desktop's own sign-in (or the group's or
         * the global default's), or null: the desktop's own whatever the defaults (an imported profile's).
         * ASK_GATEWAY_ACCOUNT asks for a separate gateway sign-in when connecting.
         */
        gatewayAccount: string | null
        /** The ways the clipboard goes with this desktop ('both', 'fromRemote', 'off'), or '' for the setting's. */
        clipboard: '' | ClipboardMode
    }
}

/** Input of an SSH tab opened for an RDP profile with `via`: the desktop to show once SSH is connected. */
const OPEN_DESKTOP = 'trdOpenDesktop'
const RECOVERY_TYPE = 'app:rdp-tab'

// ---- the tab -----------------------------------------------------------------------------------

const TAB_STYLE = `
rdp-tab { flex: auto; display: flex; position: relative; overflow: hidden; background: #111; }
rdp-tab .trd-rdp-idle { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 14px; align-items: center;
    justify-content: center; padding: 2em; text-align: center; color: #bbb; font-size: 13px; white-space: pre-line; }
`

/**
 * A remote desktop tab: the desktop layer (the same one SSH tabs get) fills it, and there is no console under it.
 * A component because Tabby opens profiles as tab components; it holds no UI of its own beyond a line and a Connect
 * button for when no desktop is open (after Disconnect).
 */
@Component({
    selector: 'rdp-tab',
    template: '',
    styles: [TAB_STYLE],
    // The idle message is built by hand, outside the template, so its styles can't be scoped to it.
    encapsulation: ViewEncapsulation.None,
})
export class RDPTabComponent extends BaseTabComponent implements OnInit {
    profile!: RDPProfile
    private idle!: HTMLElement

    constructor (
        injector: Injector,
        readonly element: ElementRef<HTMLElement>,
        private desktop: RemoteDesktopService,
        private targets: RemoteTargets,
        private zone: NgZone,
    ) {
        super(injector)
    }

    ngOnInit (): void {
        if (!this.title) {
            this.setTitle(this.profile.name)
        }
        this.idle = document.createElement('div')
        this.idle.className = 'trd-rdp-idle'
        this.idle.innerHTML = '<div class="trd-rdp-idle-text"></div><button class="btn btn-secondary">Connect</button>'
        this.idle.querySelector('button')!.addEventListener('click', () => this.zone.run(() => this.open()))
        this.element.nativeElement.appendChild(this.idle)
        this.subscribeUntilDestroyed(this.desktop.changed$, () => this.update())
        this.update()
        // Once the tab is laid out, so that the first connection gets the pane's size.
        setTimeout(() => this.open(true))
    }

    private update (): void {
        const o = this.profile.options
        const text = o.via
            ? `${this.profile.name} goes through an SSH profile that no longer exists. Choose another in its profile settings.`
            : `${this.profile.name} (${formatAddress(o.host, o.port || 3389)}) is not connected.`
        this.idle.querySelector('.trd-rdp-idle-text')!.textContent = text
        this.idle.querySelector('button')!.style.display = o.via ? 'none' : ''
        this.idle.style.display = this.desktop.has(this) ? 'none' : ''
    }

    private async open (first = false): Promise<void> {
        if (this.profile.options.via || !this.profile.options.host) {
            return
        }
        await this.targets.targetOf(this)
        const elsewhere = first && this.desktop.isOpenElsewhere(this)
        // Opened again while another tab has it: that tab comes forward (one desktop per server), and this one goes.
        await this.desktop.showDesktop(this)
        if (elsewhere) {
            this.destroy()
        }
    }

    override async getRecoveryToken (): Promise<RecoveryToken> {
        return { type: RECOVERY_TYPE, profile: this.profile }
    }
}

/** Reopens remote desktop tabs when Tabby restores its tabs (and for Duplicate). */
@Injectable()
export class RDPTabRecovery extends TabRecoveryProvider<RDPTabComponent> {
    constructor (private injector: Injector) {
        super()
    }

    async applicableTo (token: RecoveryToken): Promise<boolean> {
        return token.type === RECOVERY_TYPE
    }

    async recover (token: RecoveryToken): Promise<NewTabParameters<RDPTabComponent>> {
        return {
            type: RDPTabComponent,
            inputs: { profile: this.injector.get(ProfilesService).getConfigProxyForProfile(token.profile) },
        }
    }
}

// ---- profile settings --------------------------------------------------------------------------

/**
 * The profile's own fields in Tabby's profile editor (name, group, icon and color are Tabby's). Plain DOM like the
 * rest of the plugin, writing to the profile as you type.
 */
@Component({
    selector: 'rdp-profile-settings',
    template: '',
})
export class RDPProfileSettingsComponent implements ProfileSettingsComponent<RDPProfile>, OnInit {
    profile!: RDPProfile
    /** As the editor opened: what is kept per desktop moves along with a new address (see save()). */
    private before!: { id: string, account: string, via: string, gateway: string }

    constructor (private element: ElementRef<HTMLElement>, private injector: Injector) { }

    ngOnInit (): void {
        const o = this.profile.options
        const account = () => `${o.username ?? ''}\n${o.domain ?? ''}\n${o.account ?? ''}`
        // No id for a new profile (no address yet): it has nothing saved to take along.
        this.before = { id: o.host ? desktopIdOf(o) : '', account: account(), via: o.via ?? '', gateway: o.gateway ?? '' }
        const root = this.element.nativeElement
        root.innerHTML = `
            <div class="mb-3">
                <label>Address</label>
                <input class="form-control" name="address" spellcheck="false" placeholder="e.g. 192.168.1.20, or pc.local:3390">
                <div class="text-danger small" data-for="address"></div>
            </div>
            <div class="mb-3">
                <label>Connect</label>
                <select class="form-control" name="via"><option value="">Directly from this computer</option></select>
                <div class="text-muted small">Through an SSH profile, the address is as that host sees it, and the desktop opens over its SSH tab.</div>
            </div>
            <div class="mb-3">
                <label>Kind</label>
                <select class="form-control" name="kind">
                    <option value="windows">Windows (or another RDP server)</option>
                    <option value="xrdp">xrdp (Linux: KDE, XFCE, MATE, …)</option>
                    <option value="gnome">GNOME Remote Desktop (needs the graphics pipeline)</option>
                </select>
            </div>
            <div class="mb-3">
                <label>Account</label>
                <select class="form-control" name="account"></select>
                <div class="text-muted small">A saved account's password is kept once, for every desktop that signs in with it.
                    Add one here with "New account…", or in Settings › Remote Desktop › Accounts.</div>
            </div>
            <div class="mb-3" data-own-account>
                <label>User name</label>
                <input class="form-control" name="username" spellcheck="false" placeholder="Optional; asked when connecting. DOMAIN\\user works too">
            </div>
            <div class="mb-3" data-own-account>
                <label>Domain</label>
                <input class="form-control" name="domain" spellcheck="false" placeholder="Optional">
            </div>
            <div class="mb-3">
                <label>RD Gateway</label>
                <input class="form-control" name="gateway" spellcheck="false" placeholder="Optional: a Remote Desktop Gateway, e.g. rdgw.example.com">
                <div class="text-danger small" data-for="gateway"></div>
                <div class="text-muted small">The desktop is then reached through the gateway (HTTPS, port 443 unless given), and the address above is as the gateway sees it.</div>
            </div>
            <div class="mb-3" data-gateway-account>
                <label>Gateway account</label>
                <select class="form-control" name="gatewayAccount"></select>
                <div class="text-muted small">A gateway that takes another account than the desktop: a saved account for it.</div>
            </div>
            <div class="mb-3">
                <label>Clipboard</label>
                <select class="form-control" name="clipboard"></select>
                <div class="text-muted small">Which ways text, pictures and files copied on either side go between this computer and the desktop.
                    Applies on the next connection.</div>
            </div>`
        const field = <T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(name: string) => root.querySelector(`[name="${name}"]`) as T
        field('address').value = o.host ? formatAddress(o.host, o.port || 3389) : ''
        field<HTMLSelectElement>('kind').value = o.kind === 'gnome' || o.kind === 'xrdp' ? o.kind : 'windows'
        field('username').value = o.username ?? ''
        field('domain').value = o.domain ?? ''

        field('address').addEventListener('input', () => {
            const text = field('address').value
            const address = parseAddress(text)
            root.querySelector('[data-for=address]')!.textContent = text.trim() && !address ? 'This doesn\'t look like an address.' : ''
            if (address) {
                o.host = address.host
                o.port = address.port
            }
        })
        field<HTMLSelectElement>('kind').addEventListener('change', () => {
            const kind = field<HTMLSelectElement>('kind').value
            o.kind = kind === 'gnome' || kind === 'xrdp' ? kind : 'windows'
        })
        const desktop = this.injector.get(RemoteDesktopService)
        const accounts = desktop.accounts()
        const saved = field<HTMLSelectElement>('account')
        const label = (a: { name: string, username: string, domain?: string }) => `${a.name} (${signInName(a)})`
        saved.append(new Option('Ask for the account when connecting', ''), ...accounts.map(a => new Option(label(a), a.id)))
        if (o.account && !accounts.some(a => a.id === o.account)) {
            saved.append(new Option('(a saved account that no longer exists)', o.account))
        }
        saved.value = o.account ?? ''
        const ownAccount = () => root.querySelectorAll<HTMLElement>('[data-own-account]').forEach(el => { el.hidden = !!saved.value })
        // "New account…" at the end: a small form right here, so the profile being edited isn't left.
        newAccountOption(saved, label, async input => {
            const { id, keychainError } = await desktop.saveAccount({ name: input.name, username: input.username, domain: input.domain }, input.password)
            if (keychainError) {
                throw new Error(keychainError)
            }
            return desktop.accounts().find(a => a.id === id)!
        }, id => { o.account = id })
        saved.addEventListener('change', ownAccount)
        ownAccount()
        field('username').addEventListener('input', () => { o.username = field('username').value.trim() })
        field('domain').addEventListener('input', () => { o.domain = field('domain').value.trim() })

        // The gateway, and its separate account or sign-in prompt.
        const gateway = field('gateway')
        const gatewayAccount = field<HTMLSelectElement>('gatewayAccount')
        gateway.value = o.gateway ?? ''
        gatewayAccount.append(new Option('The same as the desktop\'s', ''), new Option('Ask for a gateway account when connecting', ASK_GATEWAY_ACCOUNT),
            ...accounts.map(a => new Option(label(a), a.id)))
        if (o.gatewayAccount && o.gatewayAccount !== ASK_GATEWAY_ACCOUNT && !accounts.some(a => a.id === o.gatewayAccount)) {
            gatewayAccount.append(new Option('(a saved account that no longer exists)', o.gatewayAccount))
        }
        gatewayAccount.value = o.gatewayAccount ?? ''
        const gatewayChanged = () => {
            const text = gateway.value.trim()
            root.querySelector('[data-for=gateway]')!.textContent = text && !parseGateway(text) ? 'A name or address, with :port if it isn\'t 443.' : ''
            root.querySelector<HTMLElement>('[data-gateway-account]')!.hidden = !text || gatewayAccount.options.length < 2
        }
        gateway.addEventListener('input', () => {
            o.gateway = gateway.value.trim()
            gatewayChanged()
        })
        gatewayAccount.addEventListener('change', () => { o.gatewayAccount = gatewayAccount.value })
        gatewayChanged()

        // Its own clipboard sharing, or the setting's (named, as it is now).
        const clipboard = field<HTMLSelectElement>('clipboard')
        clipboard.append(new Option(`As in Settings › Remote Desktop (${CLIPBOARD_LABELS[desktop.settings().clipboard].toLowerCase()})`, ''),
            ...(Object.entries(CLIPBOARD_LABELS) as [ClipboardMode, string][]).map(([mode, text]) => new Option(text, mode)))
        clipboard.value = ownClipboard(o.clipboard) ?? ''
        clipboard.addEventListener('change', () => { o.clipboard = clipboard.value as '' | ClipboardMode })

        const via = field<HTMLSelectElement>('via')
        via.addEventListener('change', () => { o.via = via.value })
        this.injector.get(ProfilesService).getProfiles().then(profiles => {
            const ssh = profiles.filter(p => p.type === 'ssh' && !p.isTemplate && p.id)
            if (o.via && !ssh.some(p => p.id === o.via)) {
                via.append(new Option('(an SSH profile that no longer exists)', o.via))
            }
            via.append(...ssh.map(p => new Option(`Through ${p.name}`, p.id!)))
            via.value = o.via ?? ''
        }, () => null)
    }

    save (): void {
        const o = this.profile.options
        const { id, account, via, gateway } = this.before
        if (!id) {
            return
        }
        if ((o.via ?? '') !== via) {
            // Reached another way, it is another desktop. A direct one's saved passwords (through any gateway, the ones
            // it had before included) and certificate were its own; one behind a host shares them with that host's
            // desktop at the same address, so they stay.
            if (!via) {
                this.injector.get(RemoteDesktopService).forgetDesktop(id, true, `"${this.profile.name}"`).catch(() => null)
            }
            return
        }
        // Its saved password goes with its way there (see desktopEdited): another gateway is asked for again.
        const accountChanged = `${o.username ?? ''}\n${o.domain ?? ''}\n${o.account ?? ''}` !== account
        this.injector.get(RemoteDesktopService).desktopEdited(id, desktopIdOf(o), accountChanged, !via, { from: gateway, to: o.gateway }).catch(() => null)
    }
}

// ---- the profile provider ----------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class RDPProfilesService extends QuickConnectProfileProvider<RDPProfile> {
    override id = RDP_PROFILE_TYPE
    override name = 'Remote desktop (RDP)'
    override settingsComponent = RDPProfileSettingsComponent
    override configDefaults = {
        options: { host: '', port: 3389, kind: 'windows', username: '', domain: '', account: '', via: '', gateway: '', gatewayAccount: '', clipboard: '' },
        clearServiceMessagesOnConnect: false,
    }

    // ProfilesService depends on this provider: it is looked up when needed, not injected.
    constructor (private injector: Injector, private config: ConfigService) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<RDPProfile>[]> {
        // No clipboard here: a new profile is made from a copy of this, and a value saved with it (even '', the
        // setting's) would hide the clipboard its group's or the type's defaults give it, which may well be narrower.
        // Left out, the profile follows those defaults (configDefaults has the key) until it is given one of its own.
        return [{
            id: `${RDP_PROFILE_TYPE}:template`,
            type: RDP_PROFILE_TYPE,
            name: 'Remote desktop (RDP)',
            icon: 'fas fa-desktop',
            options: { host: '', port: 3389, kind: 'windows', username: '', domain: '', account: '', via: '', gateway: '', gatewayAccount: '' },
            isBuiltin: true,
            isTemplate: true,
        }]
    }

    async getNewTabParameters (profile: RDPProfile): Promise<NewTabParameters<BaseTabComponent>> {
        if (profile.options.via) {
            // The desktop behind an SSH host opens over that host's SSH tab, like any desktop behind a host.
            const profiles = this.injector.get(ProfilesService)
            const ssh = (await profiles.getProfiles()).find(p => p.id === profile.options.via)
            const params = ssh && await profiles.newTabParametersForProfile(ssh)
            if (params) {
                params.inputs = { ...params.inputs, [OPEN_DESKTOP]: desktopIdOf(profile.options) }
                return params
            }
            // The SSH profile is gone: the tab says so.
        }
        return { type: RDPTabComponent, inputs: { profile } }
    }

    override getSuggestedName (profile: PartialProfile<RDPProfile>): string | null {
        return profile.options?.host || null
    }

    getDescription (profile: PartialProfile<RDPProfile>): string {
        const o = profile.options ?? {}
        // Each field as text whatever the config holds (see configText): Tabby asks this of every profile as it lists
        // them in its profile selector, and one that throws keeps the selector from opening at all.
        const host = configText(o.host)
        if (!host) {
            return ''
        }
        const address = formatAddress(host, configNumber(o.port || 3389))
        const gateway = configText(o.gateway)
        const via = [
            ...gateway ? [`the gateway ${gateway}`] : [],
            ...o.via ? [configText((this.config.store.profiles ?? []).find((p: any) => p.id === o.via)?.name) || 'an SSH profile'] : [],
        ]
        return via.length ? `${address} via ${via.join(', via ')}` : address
    }

    /** `[user@]host[:port]`, typed in Tabby's profile selector. */
    quickConnect (query: string): PartialProfile<RDPProfile> | null {
        const at = query.lastIndexOf('@')
        const address = parseAddress(query.slice(at + 1))
        if (!address) {
            return null
        }
        return {
            name: query.trim(),
            type: RDP_PROFILE_TYPE,
            options: { host: address.host, port: address.port, username: at > 0 ? query.slice(0, at).trim() : '' },
        }
    }

    intoQuickConnectString (profile: RDPProfile): string | null {
        const o = profile.options
        // As text, as getDescription reads them: the profile selector asks this of every profile too.
        const username = configText(o.username)
        return o.via ? null : `${username ? `${username}@` : ''}${formatAddress(configText(o.host), configNumber(o.port || 3389))}`
    }

    override deleteProfile (profile: RDPProfile): void {
        // A direct desktop's saved passwords (through any gateway: one it went through before too) and certificate are
        // its own; one behind a host shares them with that host's desktop at the same address.
        if (!profile.options.via) {
            this.injector.get(RemoteDesktopService).forgetDesktop(desktopIdOf(profile.options), true, `"${profile.name}"`).catch(() => null)
        }
    }
}

/** In Tabby's command palette, also where no SSH tab (and so no Remote Desktop › Settings menu) is at hand. */
@Injectable()
export class RDPCommands extends CommandProvider {
    constructor (private desktop: RemoteDesktopService, private help: RemoteDesktopHelp) {
        super()
    }

    async provide (): Promise<Command[]> {
        return [{
            id: 'tabby-rdp:import-rdp-file',
            label: 'Remote desktop: import an .rdp file…',
            run: () => this.desktop.importRdpFile(),
        }, {
            id: 'tabby-rdp:help',
            label: 'Remote desktop: settings, keys and help',
            run: async () => this.help.open(),
        }]
    }
}

/** Shows the desktop an RDP profile with `via` asked for, over the SSH tab opened for it, once SSH is connected. */
@Injectable()
export class RDPProfileOpener extends TerminalDecorator {
    constructor (private desktop: RemoteDesktopService, private zone: NgZone) {
        super()
    }

    override attach (terminal: BaseTerminalTabComponent<any>): void {
        const tab = terminal as BaseTerminalTabComponent<any> & { [OPEN_DESKTOP]?: string }
        const id = tab[OPEN_DESKTOP]
        if (!id || !isSSHTab(tab)) {
            return
        }
        // Only for the first connection, not after a reconnect.
        delete tab[OPEN_DESKTOP]
        let closed = false
        tab.destroyed$.subscribe(() => { closed = true })
        // Not before: the desktop layer would cover a password prompt or host key question in the terminal.
        const wait = (tries: number) => {
            if (closed) {
                return
            }
            if (isConnected(tab)) {
                this.zone.run(() => this.desktop.showDesktop(tab, id))
            } else if (tries > 0) {
                setTimeout(() => wait(tries - 1), 250)
            }
        }
        this.zone.runOutsideAngular(() => wait(4 * 60 * 5))
    }
}
