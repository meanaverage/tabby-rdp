import { Component, ElementRef, HostBinding, Injectable, Injector, NgZone, OnDestroy, OnInit } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppService, ConfigService, NotificationsService, PlatformService, ProfilesService } from 'tabby-core'
import { SettingsTabComponent, SettingsTabProvider } from 'tabby-settings'
import { DesktopSettings, RemoteDesktopService } from './desktop.service'
import { DIRECT_KEY } from './desktops'
import { OSD_FONTS, OSD_POSITIONS, OSD_SIZES, OSD_STYLE, OsdSettings, renderOsd } from './osd'
import { HelpTopic, RemoteDesktopHelp, SETTINGS_TAB_ID, TROUBLESHOOTING } from './help'
import { installedVersion, UpdateCheck } from './updates'
import { RDP_PROFILE_TYPE } from './targets'

const REPO = 'https://github.com/meanaverage/tabby-rdp'

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const k = (s: string) => `<kbd>${esc(s)}</kbd>`

const STYLE = `
.trd-settings { display: block; }
.trd-settings h3 { margin-bottom: 4px; }
.trd-settings .trd-lead { margin-bottom: 18px; opacity: 0.75; }
.trd-settings .trd-links { white-space: nowrap; }
.trd-settings .trd-lead a { margin-left: 10px; }
.trd-settings .trd-update { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; padding: 10px 12px; border-radius: 6px;
    border: 1px solid rgba(80, 150, 255, 0.45); background: rgba(80, 150, 255, 0.1); }
.trd-settings .trd-update > div { flex: auto; }
.trd-settings .trd-update:empty { display: none; }
.trd-settings section { margin-bottom: 28px; scroll-margin-top: 12px; }
.trd-settings section > h4 { font-size: 15px; margin-bottom: 10px; }
.trd-settings .trd-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.trd-settings .trd-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 6px;
    border: 1px solid rgba(128, 128, 128, 0.25); }
.trd-settings .trd-card .trd-card-title { font-weight: 600; }
.trd-settings .trd-card .trd-card-text { flex: auto; font-size: 12px; opacity: 0.8; }
.trd-settings .trd-card button { align-self: flex-start; }
.trd-settings kbd { padding: 1px 5px; border-radius: 3px; font-size: 11px; background: rgba(128, 128, 128, 0.25);
    color: inherit; white-space: nowrap; }
.trd-settings .trd-keys { width: 100%; font-size: 13px; }
.trd-settings .trd-keys td { padding: 5px 0; vertical-align: top; border-bottom: 1px solid rgba(128, 128, 128, 0.15); }
.trd-settings .trd-keys td:first-child { width: 38%; padding-right: 12px; }
.trd-settings .trd-list { display: flex; flex-direction: column; gap: 6px; }
.trd-settings .trd-row { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 6px;
    border: 1px solid rgba(128, 128, 128, 0.2); }
.trd-settings .trd-row > div { flex: auto; min-width: 0; }
.trd-settings .trd-row .trd-sub { font-size: 12px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; }
.trd-settings .trd-empty { font-size: 12px; opacity: 0.7; }
.trd-settings details { border-bottom: 1px solid rgba(128, 128, 128, 0.15); padding: 6px 0; }
.trd-settings details summary { cursor: pointer; }
.trd-settings details > div { padding: 6px 0 4px 16px; font-size: 13px; opacity: 0.85; }
.trd-settings .trd-flash { animation: trd-flash 1.6s ease-out; border-radius: 6px; }
@keyframes trd-flash { from { background: rgba(80, 150, 255, 0.28); } }
.trd-settings .form-line .description kbd { font-size: 10px; }
.trd-settings .form-line { gap: 24px; }
.trd-settings .form-line > .header { min-width: 0; }
.trd-settings .form-line select { min-width: 200px; flex: none; }
.trd-settings .trd-osd-preview { position: relative; aspect-ratio: 16 / 9; max-width: 520px; margin: 4px 0 14px; border-radius: 6px;
    overflow: hidden; background: linear-gradient(115deg, #e9edf1 0%, #cfd6dd 38%, #3a4048 62%, #1c1f24 100%); }
.trd-settings .trd-osd-stage { position: absolute; top: 0; left: 0; width: 1280px; height: 720px; transform-origin: 0 0; }
.trd-settings .trd-osd-preview .trd-osd { opacity: 1; }
.trd-settings .trd-color { display: flex; gap: 8px; align-items: center; }
.trd-settings .trd-color input[type=color] { width: 40px; height: 28px; padding: 0; border: 0; background: none; }
`

/** "Remote Desktop" in Tabby's settings sidebar. */
@Injectable()
export class RemoteDesktopSettingsTab extends SettingsTabProvider {
    override id = SETTINGS_TAB_ID
    override icon = 'desktop'
    override title = 'Remote Desktop'

    override getComponentType (): any {
        return RemoteDesktopSettingsComponent
    }
}

type Toggle = Exclude<{ [K in keyof DesktopSettings]: DesktopSettings[K] extends boolean ? K : never }[keyof DesktopSettings], undefined>

/**
 * The plugin's settings page: getting started, the settings, keys, desktops and certificates it keeps, and
 * troubleshooting. Plain DOM like the rest of the plugin; the lists follow config changes made elsewhere.
 */
@Component({
    selector: 'remote-desktop-settings',
    template: '',
})
export class RemoteDesktopSettingsComponent implements OnInit, OnDestroy {
    @HostBinding('class.content-box') contentBox = true
    @HostBinding('class.trd-settings') trdSettings = true
    private subscriptions: Subscription[] = []

    constructor (
        private element: ElementRef<HTMLElement>,
        private desktop: RemoteDesktopService,
        private help: RemoteDesktopHelp,
        private config: ConfigService,
        private platform: PlatformService,
        private injector: Injector,
        private zone: NgZone,
    ) { }

    ngOnInit (): void {
        if (!document.getElementById('trd-settings-style')) {
            const style = document.createElement('style')
            style.id = 'trd-settings-style'
            style.textContent = STYLE + OSD_STYLE
            document.head.appendChild(style)
        }
        this.render()
        // The preview is a 1280×720 desktop, scaled down to fit the page.
        const frame = this.root.querySelector<HTMLElement>('.trd-osd-preview')!
        const scale = new ResizeObserver(() => {
            frame.querySelector<HTMLElement>('.trd-osd-stage')!.style.transform = `scale(${frame.clientWidth / 1280})`
        })
        scale.observe(frame)
        this.subscriptions.push({ unsubscribe: () => scale.disconnect() } as Subscription)
        this.subscriptions.push(
            this.config.changed$.subscribe(() => this.refresh()),
            this.desktop.changed$.subscribe(() => this.refresh()),
            this.help.show$.subscribe(({ topic, entry }) => setTimeout(() => this.reveal(topic, entry))),
            this.injector.get(UpdateCheck).changed$.subscribe(() => this.refresh()),
        )
        const pending = this.help.pending
        this.help.pending = null
        if (pending) {
            setTimeout(() => this.reveal(pending.topic, pending.entry))
        }
    }

    ngOnDestroy (): void {
        this.subscriptions.forEach(s => s.unsubscribe())
    }

    private get root (): HTMLElement {
        return this.element.nativeElement
    }

    private render (): void {
        const mac = process.platform === 'darwin'
        const version = (() => {
            try {
                return require('../package.json').version as string
            } catch {
                return ''
            }
        })()
        this.root.innerHTML = `
            <h3>Remote Desktop</h3>
            <div class="trd-lead">Linux and Windows desktops in Tabby tabs, through SSH or directly.
                ${version ? `<span>tabby-rdp ${esc(version)}</span>` : ''}
                <span class="trd-links"><a href="#" data-link="${REPO}#readme">Guide</a><a href="#" data-link="${REPO}/issues">Report a problem</a></span></div>
            <div class="trd-update" data-update></div>

            <section data-topic="start">
                <h4>Getting started</h4>
                <div class="trd-cards">
                    <div class="trd-card">
                        <div class="trd-card-title">Over SSH</div>
                        <div class="trd-card-text">In an SSH tab, press <span data-hotkey></span> or click <b>Desktop</b> in its
                            toolbar. The host is set up the first time (GNOME, xrdp, or Windows with OpenSSH); nothing to
                            install here, no ports to open.</div>
                        <button class="btn btn-secondary btn-sm" data-action="ssh">Open a connection…</button>
                    </div>
                    <div class="trd-card">
                        <div class="trd-card-title">On your network</div>
                        <div class="trd-card-text">A remote desktop profile connects straight to an RDP server's address, in a
                            tab of its own. Or type <code>user@host</code> in the profile selector.</div>
                        <button class="btn btn-secondary btn-sm" data-action="profile">New profile…</button>
                    </div>
                    <div class="trd-card">
                        <div class="trd-card-title">From an .rdp file</div>
                        <div class="trd-card-text">A file from Remote Desktop Connection or your admin becomes a profile: its
                            address, user name and domain.</div>
                        <button class="btn btn-secondary btn-sm" data-action="import">Import an .rdp file…</button>
                    </div>
                </div>
            </section>

            <section data-topic="settings">
                <h4>Settings</h4>
                <div class="form-line">
                    <div class="header">
                        <div class="title">When the pane is resized</div>
                        <div class="description">Resizing follows splits and the window; a kept resolution can be scaled or
                            shown at actual size with scroll bars.</div>
                    </div>
                    <select class="form-control" data-setting="resize">
                        <option value="live">Resize to fit</option>
                        <option value="reconnect">Reconnect at the new size</option>
                        <option value="fit">Keep the size, scaled</option>
                        <option value="actual">Keep the size, 1:1</option>
                    </select>
                </div>
                <div class="form-line">
                    <div class="header">
                        <div class="title">Sharpness</div>
                        <div class="description">Retina renders at your screen's pixels, with the remote's scale set to
                            match. A desktop can have its own, in its tab's menu.</div>
                    </div>
                    <select class="form-control" data-setting="sharpness">
                        <option value="standard">Standard</option>
                        <option value="retina">Retina</option>
                    </select>
                </div>
                ${this.toggleLine('sound', 'Sound', 'Play the remote desktop\'s sound here. Applies on the next connection.')}
                ${this.toggleLine('microphone', 'Microphone', 'Send your microphone while an app there records, with a red dot in the corner meanwhile. Applies on the next connection.')}
                ${this.toggleLine('h264', 'Video decoding (H.264)', 'Decodes what the remote sends as video, hardware-accelerated where available. Applies on the next connection.')}
                ${this.toggleLine('connectionStatus', 'Show connection status', 'A small line in the desktop\'s corner: throughput, frames per second, round trip, and how it\'s connected.')}
                ${mac ? this.toggleLine('macShortcuts', 'Mac-style shortcuts', 'Use ⌘ as Ctrl on the desktop, so ⌘C copies and ⌘V pastes. Tap ⌘ on its own for the Windows key. When off, ⌘ is always the Windows key.') : ''}
                ${this.toggleLine('checkUpdates', 'Tell me about new versions', 'Once a day, asks npm (registry.npmjs.org) for the latest tabby-rdp, and says so here and in the menus when there is one. Nothing is sent but the request. Tabby itself shows plugin upgrades only on its Plugins page.')}
                ${this.toggleLine('discoverVMs', 'Find virtual machines on SSH hosts', 'Lists the host\'s libvirt VMs that have a desktop (RDP answering, or Windows and shut off) in its tab\'s menu, ready to open or start. Read-only: it runs virsh as you there, at most once a minute.')}
                ${this.toggleLine('desk', 'desk: bring the console along', `Type <code>desk</code> in an SSH console to show that same shell on the desktop. Installs a small helper and a login line on GNOME hosts the next time a desktop opens there; off removes them.`)}
                <div class="form-line">
                    <div class="header">
                        <div class="title">Switch between desktop and console</div>
                        <div class="description">Also the <b>Desktop</b> button in an SSH tab's toolbar and in Tabby's header.</div>
                    </div>
                    <div><span data-hotkey></span> <button class="btn btn-link btn-sm" data-action="hotkeys">Change…</button></div>
                </div>
            </section>

            <section data-topic="osd">
                <h4>Desktop name overlay</h4>
                <div class="trd-lead">Names the desktop for a moment when it connects, when you switch to it, and when you click
                    into its pane, like a TV naming its input.</div>
                <div class="trd-osd-preview"><div class="trd-osd-stage"><div class="trd-osd"></div></div></div>
                <div class="form-line">
                    <div class="header"><div class="title">Show</div>
                        <div class="description">"When it helps": in split panes, and for a desktop other than the tab's own
                            connection, where the tab's title doesn't say which it is.</div></div>
                    <select class="form-control" data-osd="show">
                        <option value="auto">When it helps</option>
                        <option value="always">Every time</option>
                        <option value="off">Never</option>
                    </select>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">Font</div></div>
                    <select class="form-control" data-osd="font">${Object.entries(OSD_FONTS).map(([id, f]) => `<option value="${id}">${esc(f.label)}</option>`).join('')}</select>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">Size</div><div class="description">Smaller in a narrow pane, so a name fits.</div></div>
                    <select class="form-control" data-osd="size">${Object.keys(OSD_SIZES).map(id => `<option value="${id}">${id === 'huge' ? 'Extra large' : id[0].toUpperCase() + id.slice(1)}</option>`).join('')}</select>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">Position</div></div>
                    <select class="form-control" data-osd="position">${OSD_POSITIONS.map(p => `<option value="${p}">${p === 'middle' ? 'Middle' : p.replace('-', ' ').replace(/^./, c => c.toUpperCase())}</option>`).join('')}</select>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">Color</div><div class="description">White reads on any picture, with the soft
                        shadow behind it. The line before the second row takes your theme's accent color.</div></div>
                    <div class="trd-color"><input type="color" data-osd="color"><button class="btn btn-link btn-sm" data-action="osd-white">White</button></div>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">How long</div></div>
                    <select class="form-control" data-osd="seconds">
                        <option value="1.5">1.5 seconds</option>
                        <option value="2.5">2.5 seconds</option>
                        <option value="4">4 seconds</option>
                        <option value="6">6 seconds</option>
                    </select>
                </div>
                <button class="btn btn-secondary btn-sm" data-action="osd-try">Show it on open desktops</button>
            </section>

            <section data-topic="keyboard">
                <h4>Keys and tips</h4>
                <table class="trd-keys"><tbody>
                    <tr><td data-hotkey-cell></td><td>Switch between the desktop and the SSH console. The desktop keeps running.</td></tr>
                    ${mac ? `
                    <tr><td>${k('⌘C')} ${k('⌘V')} ${k('⌘Z')} …</td><td>Work as on a Mac (sent as Ctrl).</td></tr>
                    <tr><td>Tap ${k('⌘')}</td><td>The Windows key (Start, or GNOME's Activities).</td></tr>
                    <tr><td>${k('⌃⌘')} + key</td><td>The Windows key with it: ${k('⌃⌘R')} for Win+R, ${k('⌃⌘E')} for Explorer.</td></tr>` : ''}
                    <tr><td>Right-click › <b>Send keys</b></td><td>Ctrl+Alt+Del, Win+L, Task Manager and others this computer keeps for itself.</td></tr>
                    <tr><td>Drop files on the desktop</td><td>Then paste them in Files or Explorer. Files copied there offer <b>Save to Downloads</b>.</td></tr>
                    <tr><td>Right-click › <b>View only</b></td><td>Watch without touching: no keys or clicks go to the desktop.</td></tr>
                    <tr><td>Right-click › <b>Save a screenshot</b></td><td>The full-resolution screen, to Downloads and the clipboard.</td></tr>
                    <tr><td>Tabby's shortcuts</td><td>While a desktop shows, only switching tabs, full screen and the switch above stay Tabby's; the rest go to the desktop.</td></tr>
                </tbody></table>
            </section>

            <section data-topic="desktops">
                <h4>Desktops behind SSH hosts</h4>
                <div class="trd-list" data-list="desktops"></div>
            </section>

            <section data-topic="certificates">
                <h4>Remembered certificates</h4>
                <div class="trd-list" data-list="certificates"></div>
            </section>

            <section data-topic="troubleshooting">
                <h4>Troubleshooting</h4>
                <div data-list="troubleshooting">${TROUBLESHOOTING.map(e => `
                    <details data-entry="${esc(e.id)}"><summary>${esc(e.title)}</summary><div>${e.body}</div></details>`).join('')}
                </div>
                <h4 style="margin-top: 18px">Open desktops</h4>
                <div class="trd-list" data-list="sessions"></div>
            </section>`

        this.root.querySelectorAll<HTMLElement>('[data-setting]').forEach(el => {
            el.addEventListener('change', () => this.zone.run(() => this.changeSetting(el)))
        })
        this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-osd]').forEach(el => {
            // The color picker reports while dragging (input) and when closed (change).
            el.addEventListener(el.type === 'color' ? 'input' : 'change', () => this.zone.run(() => {
                const key = el.dataset.osd as keyof OsdSettings
                this.changeOsd({ [key]: key === 'seconds' ? Number(el.value) : el.value })
            }))
        })
        this.root.querySelectorAll<HTMLElement>('[data-link]').forEach(el => el.addEventListener('click', event => {
            event.preventDefault()
            this.platform.openExternal(el.dataset.link!)
        }))
        const actions: Record<string, () => void> = {
            ssh: () => this.openConnection(),
            profile: () => this.newProfile(),
            import: () => this.desktop.importRdpFile(),
            hotkeys: () => this.showTabbySettings('hotkeys'),
            'osd-white': () => this.changeOsd({ color: '' }),
            'osd-try': () => {
                if (!this.desktop.showOsdEverywhere()) {
                    this.injector.get(NotificationsService).info('No desktop is showing right now')
                }
            },
        }
        this.root.querySelectorAll<HTMLElement>('[data-action]').forEach(el => el.addEventListener('click', () => {
            this.zone.run(() => actions[el.dataset.action!]?.())
        }))
        this.refresh()
    }

    private toggleLine (key: Toggle, title: string, description: string): string {
        return `
            <div class="form-line">
                <div class="header"><div class="title">${esc(title)}</div><div class="description">${description}</div></div>
                <div class="form-check form-switch"><input type="checkbox" class="form-check-input" data-setting="${key}"></div>
            </div>`
    }

    private changeOsd (change: Partial<OsdSettings>): void {
        this.desktop.updateSettings({ osd: { ...this.desktop.settings().osd, ...change } })
    }

    private changeSetting (el: HTMLElement): void {
        const key = el.dataset.setting!
        if (el instanceof HTMLInputElement) {
            this.desktop.updateSettings({ [key]: el.checked } as Partial<DesktopSettings>)
        } else if (key === 'resize') {
            const value = (el as HTMLSelectElement).value
            this.desktop.updateSettings(value === 'fit' || value === 'actual' ? { resize: 'off', zoom: value } : { resize: value as DesktopSettings['resize'] })
        } else {
            this.desktop.updateSettings({ [key]: (el as HTMLSelectElement).value } as Partial<DesktopSettings>)
        }
    }

    /** Puts the current values in the controls and rebuilds the lists. */
    private refresh (): void {
        const settings = this.desktop.settings()
        this.root.querySelectorAll<HTMLElement>('[data-setting]').forEach(el => {
            const key = el.dataset.setting as keyof DesktopSettings
            if (el instanceof HTMLInputElement) {
                el.checked = !!settings[key]
            } else if (key === 'resize') {
                (el as HTMLSelectElement).value = settings.resize === 'off' ? settings.zoom : settings.resize
            } else {
                (el as HTMLSelectElement).value = String(settings[key])
            }
        })
        // A newer version: say so at the top, with where to get it.
        const updates = this.injector.get(UpdateCheck)
        const banner = this.root.querySelector<HTMLElement>('[data-update]')
        if (banner) {
            banner.innerHTML = updates.available ? `<div><b>tabby-rdp ${esc(updates.available)} is available.</b> You have ${esc(installedVersion())}.</div>
                <button class="btn btn-primary btn-sm" data-upgrade>Upgrade…</button><button class="btn btn-link btn-sm" data-whatsnew>What's new</button>` : ''
            banner.querySelector('[data-upgrade]')?.addEventListener('click', () => updates.upgrade())
            banner.querySelector('[data-whatsnew]')?.addEventListener('click', () => updates.whatsNew())
        }
        const osd = settings.osd
        this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-osd]').forEach(el => {
            const key = el.dataset.osd as keyof OsdSettings
            // A color input takes #rrggbb only: white stands for the default.
            el.value = key === 'color' ? (/^#[0-9a-f]{6}$/i.test(osd.color) ? osd.color : '#ffffff') : String(osd[key])
        })
        const stage = this.root.querySelector<HTMLElement>('.trd-osd-stage .trd-osd')
        if (stage) {
            renderOsd(stage, 'workstation', 'via jumphost · 1280×720', osd)
        }
        const hotkey = this.help.toggleHotkey()
        this.root.querySelectorAll<HTMLElement>('[data-hotkey]').forEach(el => {
            el.innerHTML = hotkey ? k(hotkey) : '<i>(no shortcut)</i>'
        })
        const cell = this.root.querySelector('[data-hotkey-cell]')
        if (cell) {
            cell.innerHTML = hotkey ? k(hotkey) : 'The <b>Desktop</b> button'
        }
        this.renderDesktops()
        this.renderCertificates()
        this.renderSessions()
    }

    private row (title: string, sub: string, buttons: { label: string, run: () => void, danger?: boolean }[]): HTMLElement {
        const row = document.createElement('div')
        row.className = 'trd-row'
        row.innerHTML = `<div><div>${title}</div><div class="trd-sub">${sub}</div></div>`
        for (const b of buttons) {
            const button = document.createElement('button')
            button.className = `btn btn-sm ${b.danger ? 'btn-outline-danger' : 'btn-secondary'}`
            button.textContent = b.label
            button.addEventListener('click', () => this.zone.run(b.run))
            row.appendChild(button)
        }
        return row
    }

    private empty (html: string): HTMLElement {
        const div = document.createElement('div')
        div.className = 'trd-empty'
        div.innerHTML = html
        return div
    }

    private renderDesktops (): void {
        const list = this.root.querySelector('[data-list=desktops]')
        if (!list) {
            return
        }
        const desktops = this.desktop.configuredDesktops()
        list.replaceChildren(...desktops.map((d, i) => {
            const address = `${d.host ?? '127.0.0.1'}:${d.port ?? 3389}`
            const wake = d.wake?.vm ? ` · starts VM ${esc(d.wake.vm)}` : d.wake?.mac ? ` · wakes ${esc(d.wake.mac)}` : ''
            return this.row(esc(d.name ?? address), `${esc(address)} behind ${esc(d.via)} · ${esc(d.kind ?? 'windows')}${d.username ? ` · ${esc(d.username)}` : ''}${wake}`, [
                { label: 'Remove…', danger: true, run: () => { this.desktop.confirmRemoveDesktop(i) } },
            ])
        }), this.empty(desktops.length
            ? 'To edit one, right-click its host\'s SSH tab › Settings › Edit a desktop.'
            : 'None yet. A Windows VM or another computer an SSH host can reach: right-click that host\'s SSH tab › <b>Desktops › Add a desktop behind…</b>'))
    }

    private renderCertificates (): void {
        const list = this.root.querySelector('[data-list=certificates]')
        if (!list) {
            return
        }
        const entries = this.desktop.trustedCertificates()
        list.replaceChildren(...entries.map(({ desktop, sha256 }) => {
            const [who, address] = desktop.includes('#') ? desktop.split('#', 2) : [desktop, '']
            const title = address ? who === DIRECT_KEY ? `${esc(address)} (direct)` : `${esc(address)} behind ${esc(who)}` : esc(who)
            return this.row(title, `SHA-256 ${esc(sha256.slice(0, 23))}…`, [
                { label: 'Forget', run: () => this.desktop.forgetCertificate(desktop) },
            ])
        }), this.empty(entries.length
            ? 'A forgotten certificate is remembered again, without asking, on the next connection.'
            : 'None yet. Windows and xrdp desktops\' certificates are remembered on first use and checked every time after; GNOME desktops only accept the one the plugin made.'))
    }

    private renderSessions (): void {
        const list = this.root.querySelector('[data-list=sessions]')
        if (!list) {
            return
        }
        const sessions = this.desktop.sessionSummaries()
        list.replaceChildren(...sessions.map(s => this.row(esc(s.name), `${s.where ? `via ${esc(s.where)} · ` : ''}${esc(s.state)}`, [
            { label: 'Copy log', run: () => this.copyLog(s.name, s.log) },
        ])), ...sessions.length ? [] : [this.empty('No desktop is open. Each open desktop\'s connection log can be copied from here, for a bug report.')])
    }

    private copyLog (name: string, log: string[]): void {
        const version = (() => {
            try {
                return require('../package.json').version
            } catch {
                return '?'
            }
        })()
        this.platform.setClipboard({ text: [`tabby-rdp ${version} on ${process.platform}: ${name}`, ...log].join('\n') })
    }

    /** Scrolls to a section (and opens a troubleshooting entry), with a short highlight. */
    private reveal (topic: HelpTopic, entry?: string): void {
        const target = (entry && this.root.querySelector<HTMLDetailsElement>(`details[data-entry="${CSS.escape(entry)}"]`))
            || this.root.querySelector<HTMLElement>(`[data-topic="${topic}"]`)
        if (!target) {
            return
        }
        if (target instanceof HTMLDetailsElement) {
            target.open = true
        }
        // Getting started is at the top: show the page's title with it.
        ;(topic === 'start' && !entry ? this.root : target).scrollIntoView({ block: 'start', behavior: 'smooth' })
        target.classList.remove('trd-flash')
        void target.offsetWidth
        target.classList.add('trd-flash')
    }

    private async openConnection (): Promise<void> {
        const profiles = this.injector.get(ProfilesService)
        const profile = await profiles.showProfileSelector().catch(() => null)
        if (profile) {
            await profiles.openNewTabForProfile(profile)
        }
    }

    /** Tabby's own profile editor, for a new remote desktop profile; else its Profiles page. */
    private async newProfile (): Promise<void> {
        const profiles = this.injector.get(ProfilesService)
        const template = (await profiles.getProfiles()).find(p => p.type === RDP_PROFILE_TYPE && p.isTemplate)
        const provider = template && profiles.providerForProfile(template)
        let modal: any = null
        try {
            const { NgbModal } = require('@ng-bootstrap/ng-bootstrap')
            const { EditProfileModalComponent } = require('tabby-settings')
            modal = provider && this.injector.get(NgbModal).open(EditProfileModalComponent, { size: 'lg' })
        } catch {
            modal = null
        }
        if (!modal || !template || !provider) {
            this.showTabbySettings('profiles')
            return
        }
        const { id: _id, isBuiltin: _b, isTemplate: _t, ...base } = JSON.parse(JSON.stringify(template))
        modal.componentInstance.partialProfile = { ...base, name: '' }
        modal.componentInstance.profileProvider = provider
        const result = await modal.result.catch(() => null)
        if (!result) {
            return
        }
        result.type = RDP_PROFILE_TYPE
        if (!result.name) {
            result.name = provider.getSuggestedName(profiles.getConfigProxyForProfile(result)) ?? 'Remote desktop'
        }
        await profiles.newProfile(result)
        await this.config.save()
        this.injector.get(NotificationsService).notice(`Added "${result.name}": it's in the profile list with your other connections`)
    }

    /** Another page of Tabby's settings (Hotkeys, Profiles & connections). */
    private showTabbySettings (id: string): void {
        const settings = this.injector.get(SettingsTabComponent, null)
            ?? this.injector.get(AppService).tabs.find(t => t instanceof SettingsTabComponent) as SettingsTabComponent | undefined
        if (settings) {
            settings.activeTab = id
        }
    }
}
