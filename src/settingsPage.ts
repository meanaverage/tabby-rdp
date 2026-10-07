import { Component, ElementRef, HostBinding, Injectable, Injector, NgZone, OnDestroy, OnInit } from '@angular/core'
import { basename } from 'path'
import { Subscription } from 'rxjs'
import { AppService, ConfigService, HotkeyDescription, HotkeysService, NotificationsService, PlatformService, ProfilesService } from 'tabby-core'
import { SettingsTabComponent, SettingsTabProvider } from 'tabby-settings'
import { ASK_GATEWAY_ACCOUNT, SavedAccount, signInName } from './accounts'
import { CLIPBOARD_LABELS, ownClipboard } from './clipboard'
import { DesktopSettings, RemoteDesktopService } from './desktop.service'
import { configText, DIRECT_KEY, entryText, isDesktopEntry, shownKey } from './desktops'
import { driveName } from './drives'
import { OSD_FONTS, OSD_POSITIONS, OSD_SIZES, OSD_STYLE, OsdSettings, renderOsd } from './osd'
import { esc, HelpTopic, HOTKEYS, RemoteDesktopHelp, SETTINGS_TAB_ID, TROUBLESHOOTING_URL } from './help'
import { installedVersion, UpdateCheck } from './updates'
import { renderReleaseSettings } from './releaseSettings'
import { RDP_PROFILE_TYPE } from './targets'
import { showable } from './unshowable'
import { HostCompatibility } from './hostCompat'

const REPO = 'https://github.com/meanaverage/tabby-rdp'

const k = (s: string) => `<kbd>${esc(s)}</kbd>`

/** The page's tabs (as Tabby's "Profiles & connections" page has Profiles and Advanced), each holding sections by topic. */
const TABS: { id: string, title: string, topics: HelpTopic[] }[] = [
    { id: 'start', title: 'Getting started', topics: ['start', 'keyboard'] },
    { id: 'settings', title: 'Settings', topics: ['settings'] },
    { id: 'osd', title: 'Overlay', topics: ['osd'] },
    { id: 'desktops', title: 'Desktops', topics: ['desktops', 'certificates'] },
    { id: 'accounts', title: 'Accounts', topics: ['accounts'] },
    { id: 'updates', title: 'Updates', topics: ['updates'] },
]
/** The tab shown last, so that the page comes back to it. */
let lastTab = 'start'
/** The desktop resolution the overlay preview stands for (the overlay's size depends on it). */
let previewResolution = '1920x1080'

const STYLE = `
.trd-settings { display: block; }
.trd-settings h3 { margin-bottom: 4px; }
.trd-settings .trd-lead { margin-bottom: 18px; opacity: 0.75; }
.trd-settings .trd-links { display: inline-flex; flex-wrap: wrap; gap: 6px 10px; margin-left: 10px; }
.trd-settings .trd-lead a { white-space: nowrap; }
.trd-settings section .trd-lead a { margin-left: 0; cursor: pointer; text-decoration: underline; }
.trd-settings .trd-update { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 18px; padding: 10px 12px; border-radius: 6px;
    border: 1px solid rgba(80, 150, 255, 0.45); background: rgba(80, 150, 255, 0.1); }
.trd-settings .trd-update > div { flex: auto; }
.trd-settings .trd-update:empty { display: none; }
.trd-settings .trd-release-summary { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
.trd-settings .trd-release-summary h4 { margin: 3px 0; }
.trd-settings .trd-release-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0; }
.trd-settings .trd-release-actions select { width: auto; max-width: 100%; flex: 1 1 240px; }
.trd-settings .trd-release-notice { padding: 12px; border: 1px solid rgba(80,150,255,.45); border-radius: 6px; margin-bottom: 18px; }
.trd-settings .trd-release-error { color: var(--bs-danger, #e88); }
.trd-settings [data-release-settings] .trd-sub { font-size: 12px; opacity: .75; }
.trd-settings .trd-release-pause { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
@media (max-width: 700px) { .trd-settings [data-release-settings] .form-line { flex-wrap: wrap; gap: 8px; } }
.trd-settings .nav-tabs { margin-bottom: 18px; }
.trd-settings .nav-tabs .nav-link { cursor: pointer; }
.trd-settings section { margin-bottom: 28px; scroll-margin-top: 12px; }
.trd-settings section > h4 { font-size: 15px; margin-bottom: 10px; }
.trd-settings section > h5 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; margin: 22px 0 6px; }
.trd-settings section > h5:first-of-type { margin-top: 4px; }
.trd-settings .form-line .description a { cursor: pointer; text-decoration: underline; }
.trd-settings .trd-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.trd-settings .trd-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 6px;
    border: 1px solid rgba(128, 128, 128, 0.25); }
.trd-settings .trd-card .trd-card-title { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.trd-settings .trd-card-text .trd-info, .trd-settings .trd-lead .trd-info, .trd-settings .description .trd-info { margin-left: 4px; vertical-align: middle; font-size: 13px; }
.trd-settings .trd-info { position: relative; display: inline-flex; opacity: 0.55; cursor: help; outline: none; font-weight: normal; }
.trd-settings .trd-info:hover, .trd-settings .trd-info:focus { opacity: 1; }
.trd-settings .trd-info::after { content: attr(data-tip); position: absolute; left: 0; top: calc(100% + 6px); z-index: 20; width: 260px;
    padding: 8px 10px; border-radius: 6px; font-size: 12px; font-weight: normal; line-height: 1.4; white-space: normal;
    background: var(--theme-bg-more, #2a2a2a); color: var(--bs-body-color, #ddd); border: 1px solid rgba(128, 128, 128, 0.35);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45); opacity: 0; visibility: hidden; transition: opacity 120ms; pointer-events: none; }
.trd-settings .trd-info:hover::after, .trd-settings .trd-info:focus::after { opacity: 1; visibility: visible; }
.trd-settings .trd-card .trd-card-text { flex: auto; font-size: 12px; opacity: 0.8; }
.trd-settings .trd-card button { align-self: flex-start; }
.trd-settings kbd { padding: 2px 7px; border-radius: 3px; font-size: 13px; background: rgba(128, 128, 128, 0.25);
    color: inherit; white-space: nowrap; }
.trd-settings .trd-hotkeys .row { border-bottom: 1px solid rgba(128, 128, 128, 0.15); }
.trd-settings .trd-hotkeys .trd-hotkey-name { font-size: 13px; }
.trd-settings .trd-hotkeys .trd-conflict { font-size: 12px; color: var(--bs-danger, #e55); }
.trd-settings .trd-hotkeys multi-hotkey-input { display: flex; flex-wrap: wrap; gap: 5px 0; font-size: 13px; }
.trd-settings .trd-hotkeys multi-hotkey-input .item, .trd-settings .trd-hotkeys multi-hotkey-input .item .body { display: flex; cursor: pointer; }
.trd-settings .trd-hotkeys multi-hotkey-input .add { cursor: pointer; }
.trd-capture { position: fixed; inset: 0; z-index: 2000; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); }
.trd-capture hotkey-input-modal { display: block; width: 420px; max-width: calc(100% - 32px); border-radius: 6px; background: var(--bs-body-bg, #222);
    border: 1px solid rgba(128, 128, 128, 0.35); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); }
.trd-capture .modal-header, .trd-capture .modal-footer { padding: 12px 16px; }
.trd-capture .modal-header h5 { margin: 0; }
.trd-capture .modal-body { padding: 0 16px 10px; }
.trd-capture .input { display: flex; align-items: center; }
.trd-capture .input:empty::before { content: 'Press the key now'; opacity: 0.4; font-size: 14px; }
.trd-capture .timeout { height: 3px; border-radius: 2px; overflow: hidden; }
.trd-capture .timeout div { height: 100%; transition: width 25ms linear; }
.trd-settings .trd-keys { width: 100%; font-size: 13px; }
.trd-settings .trd-keys td { padding: 5px 0; vertical-align: top; border-bottom: 1px solid rgba(128, 128, 128, 0.15); }
.trd-settings .trd-keys td:first-child { width: 38%; padding-right: 12px; }
.trd-settings .trd-list { display: flex; flex-direction: column; gap: 6px; }
.trd-settings .trd-row { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 6px;
    border: 1px solid rgba(128, 128, 128, 0.2); }
.trd-settings .trd-row > div { flex: auto; min-width: 0; }
.trd-settings .trd-row .trd-sub { font-size: 12px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; }
.trd-settings .trd-empty { font-size: 12px; opacity: 0.7; }
.trd-settings .trd-account-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px; border-radius: 6px;
    border: 1px solid rgba(128, 128, 128, 0.35); }
.trd-settings .trd-account-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; margin: 0; }
.trd-settings .trd-account-form .trd-account-error { grid-column: 1 / -1; color: #f08080; font-size: 12px; }
.trd-settings .trd-account-form .trd-account-error:empty { display: none; }
.trd-settings .trd-account-form .trd-account-buttons { grid-column: 1 / -1; display: flex; gap: 8px; justify-content: flex-end; }
.trd-settings .trd-list + .trd-add { margin-top: 10px; display: flex; gap: 6px; align-items: center; }
.trd-settings .trd-row .trd-folder-readonly { flex: none; display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; white-space: nowrap; }
.trd-settings .trd-row .trd-folder-readonly input { margin: 0; position: static; float: none; }
.trd-settings .trd-row a[data-profile], .trd-settings .trd-row a[data-desktop] { cursor: pointer; text-decoration: underline; }
.trd-settings .trd-form-overlay { position: fixed; inset: 0; z-index: 1050; background: rgba(0, 0, 0, 0.55); }
/* The window stays draggable by its tab bar while the form shows (Tabby's own dialogs cover it). */
.trd-settings .trd-form-overlay .trd-form-dragbar, .trd-capture .trd-form-dragbar { display: block; position: absolute; left: 0; right: 0; top: 0;
    height: var(--tabs-height, 38px); -webkit-app-region: drag; }
.trd-settings .trd-form-overlay .trd-signin { top: var(--tabs-height, 38px); }
.trd-settings .trd-form-overlay .trd-signin form { padding: 20px; border-radius: 6px; background: var(--bs-body-bg, #1b1b1b);
    border: 1px solid rgba(128, 128, 128, 0.35); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); width: 420px; }
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
.trd-settings .trd-osd-resolution { position: absolute; left: 10px; bottom: 10px; width: auto; padding-right: 30px; font-size: 11px; opacity: 0.85; }
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
 * updates. Plain DOM like the rest of the plugin; the lists follow config changes made elsewhere.
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
        private hotkeys: HotkeysService,
        private compat: HostCompatibility,
    ) { }

    ngOnInit (): void {
        if (!document.getElementById('trd-settings-style')) {
            const style = document.createElement('style')
            style.id = 'trd-settings-style'
            style.textContent = STYLE + OSD_STYLE
            document.head.appendChild(style)
        }
        this.render()
        // The preview is a desktop of the chosen resolution, scaled down to fit the page.
        const frame = this.root.querySelector<HTMLElement>('.trd-osd-preview')!
        const scale = new ResizeObserver(() => this.scalePreview())
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
        const version = installedVersion()
        this.root.innerHTML = `
            <h3>Remote Desktop</h3>
            <div class="trd-lead">Linux and Windows desktops in Tabby tabs, through SSH or directly.
                ${version ? `<span>tabby-rdp ${esc(version)}</span>` : ''}
                <span class="trd-links"><a href="#" data-link="${REPO}#readme">Guide</a><a href="#" data-link="${REPO}/issues">Report a problem</a><a href="#" data-link="${REPO}/discussions/categories/q-a">Ask a question</a><a href="#" data-link="${TROUBLESHOOTING_URL}">Troubleshooting</a></span></div>
            <ul class="nav nav-tabs" data-nav></ul>

            <section data-topic="start">
                <h4>Getting started</h4>
                <div class="trd-cards">
                    <div class="trd-card">
                        <div class="trd-card-title">Over SSH</div>
                        <div class="trd-card-text">In an SSH tab, press <span data-hotkey></span> or click <b>Desktop</b>.
                            ${this.info('The host is set up on the first connection: GNOME, xrdp, or Windows with OpenSSH. Nothing to install here, no ports to open.')}</div>
                        <button class="btn btn-secondary btn-sm" data-action="ssh">Open a connection…</button>
                    </div>
                    <div class="trd-card">
                        <div class="trd-card-title">On your network</div>
                        <div class="trd-card-text">A profile that connects straight to an RDP server.
                            ${this.info('The desktop opens in a tab of its own. For a quick connection, type user@host in the profile selector.')}</div>
                        <button class="btn btn-secondary btn-sm" data-action="profile">New profile…</button>
                    </div>
                    <div class="trd-card">
                        <div class="trd-card-title">From an .rdp file</div>
                        <div class="trd-card-text">The file becomes a profile.
                            ${this.info('A file from Remote Desktop Connection, or from your admin. Its address, user name and domain make the profile; the password is asked for.')}</div>
                        <button class="btn btn-secondary btn-sm" data-action="import">Import an .rdp file…</button>
                    </div>
                </div>
            </section>

            <section data-topic="settings">
                <h4>Settings</h4>
                <h5>Picture</h5>
                <div class="form-line">
                    <div class="header">
                        <div class="title">When the pane is resized</div>
                        <div class="description">Fixed resolutions use scaling or scroll bars.</div>
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
                        <div class="description">Retina uses your screen's pixel density and matching remote scaling.</div>
                    </div>
                    <select class="form-control" data-setting="sharpness">
                        <option value="standard">Standard</option>
                        <option value="retina">Retina</option>
                    </select>
                </div>
                ${this.toggleLine('h264', 'Video decoding (H.264)', 'Hardware acceleration where available. Applies on the next connection.')}
                ${this.toggleLine('connectionStatus', 'Show connection status', 'Show throughput, frame rate, latency and connection details.')}

                <h5>Sound</h5>
                ${this.toggleLine('sound', 'Sound', 'Play remote audio. Applies on the next connection.')}
                ${this.toggleLine('microphone', 'Microphone', `Share your microphone when a remote app requests it. Applies on the next connection; turning it off stops sharing immediately. ${this.info('A red indicator remains visible while sharing, including from background desktops. Its menu can stop sharing with an individual desktop. That desktop stays muted through reconnects until re-enabled or Tabby closes.')}`)}

                <h5>Clipboard</h5>
                <div class="form-line">
                    <div class="header">
                        <div class="title">Clipboard sharing</div>
                        <div class="description">Share text, images and files. Desktops can override this setting. Applies on reconnect;
                            restricting sharing stops local sends immediately.
                            ${this.info('Sharing can expose passwords and let the remote replace your local clipboard. Only the focused desktop receives your clipboard. Off disables text, images and clipboard file transfers. Restricting sharing also withdraws previously offered files.')}</div>
                    </div>
                    <select class="form-control" data-setting="clipboard">
                        ${Object.entries(CLIPBOARD_LABELS).map(([mode, label]) => `<option value="${mode}">${esc(label)}</option>`).join('')}
                    </select>
                </div>

                <h5>Shared folders</h5>
                <div class="trd-lead">Available as remote drives (<code>\\\\tsclient</code> on Windows). Applies on the next connection.
                    ${this.info('Shared with every remote desktop. Use read-only to prevent remote changes. Supported by Windows and xrdp with FUSE; unavailable on GNOME Remote Desktop.')}</div>
                <div class="trd-list" data-list="folders"></div>
                <div class="trd-add"><button class="btn btn-secondary btn-sm" data-action="folder">Share a folder…</button></div>

                <h5>Keyboard</h5>
                ${this.toggleLine('unicodeKeys', 'Send text as typed', `Send characters instead of physical keys. Modifier shortcuts still use key positions. ${this.info('Useful for dead keys or mismatched keyboard layouts. GNOME is limited to characters in its own layout. Chinese, Japanese and Korean input methods are not supported.')}`)}
                ${mac ? this.toggleLine('macShortcuts', 'Mac-style shortcuts', '⌘C copies and ⌘V pastes. Tap ⌘ for the Windows key; when disabled, ⌘ always sends the Windows key.') : ''}
                <div class="form-line">
                    <div class="header">
                        <div class="title">Shortcuts</div>
                        <div class="description">Manage in <a data-action="shortcuts">Getting started</a> or Tabby's Hotkeys.</div>
                    </div>
                    <div><span data-hotkey></span></div>
                </div>

                <h5>SSH hosts</h5>
                ${this.toggleLine('desk', 'desk integration', `Type <code>desk</code> to open your current SSH shell on the desktop. Installs a helper on GNOME hosts on the next desktop connection; disabling removes it.`)}
                ${this.toggleLine('discoverVMs', 'Find virtual machines on SSH hosts', 'List libvirt and Hyper-V VMs in the SSH tab menu. Discovery is read-only and runs at most once a minute.')}
                <div class="form-line">
                    <div class="header">
                        <div class="title">Shut down started VMs</div>
                        <div class="description">Shut down VMs started by this plugin after the selected time with no desktop open.
                            Continues after Tabby closes; previously running VMs are unaffected.</div>
                    </div>
                    <select class="form-control" data-setting="shutDownIdle">
                        <option value="0">Never</option>
                        <option value="5">After 5 minutes</option>
                        <option value="15">After 15 minutes</option>
                        <option value="60">After an hour</option>
                    </select>
                </div>

            </section>

            <section data-topic="osd">
                <h4>Desktop name overlay</h4>
                <div class="trd-lead">Show the desktop name when connecting, switching desktops or focusing a pane.</div>
                <div class="trd-osd-preview"><div class="trd-osd-stage"><div class="trd-osd"></div></div>
                    <select class="form-control form-control-sm trd-osd-resolution" data-preview-resolution title="Preview resolution">
                        <option value="1280x720">1280 × 720</option>
                        <option value="1920x1080">1920 × 1080</option>
                        <option value="2560x1440">2560 × 1440</option>
                        <option value="3840x2160">3840 × 2160</option>
                    </select></div>
                <div class="form-line">
                    <div class="header"><div class="title">Show</div>
                        <div class="description">Automatic shows names in split panes and when the tab title identifies a different connection.</div></div>
                    <select class="form-control" data-osd="show">
                        <option value="auto">Automatic</option>
                        <option value="always">Every time</option>
                        <option value="off">Never</option>
                    </select>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">Font</div></div>
                    <select class="form-control" data-osd="font">${Object.entries(OSD_FONTS).map(([id, f]) => `<option value="${id}">${esc(f.label)}</option>`).join('')}</select>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">Size</div></div>
                    <select class="form-control" data-osd="size">${Object.keys(OSD_SIZES).map(id => `<option value="${id}">${id === 'huge' ? 'Extra large' : id[0].toUpperCase() + id.slice(1)}</option>`).join('')}</select>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">Position</div></div>
                    <select class="form-control" data-osd="position">${OSD_POSITIONS.map(p => `<option value="${p}">${p === 'middle' ? 'Middle' : p.replace('-', ' ').replace(/^./, c => c.toUpperCase())}</option>`).join('')}</select>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">Color</div></div>
                    <div class="trd-color"><input type="color" data-osd="color"><button class="btn btn-link btn-sm" data-action="osd-white">White</button></div>
                </div>
                <div class="form-line">
                    <div class="header"><div class="title">Duration</div></div>
                    <select class="form-control" data-osd="seconds">
                        <option value="1.5">1.5 seconds</option>
                        <option value="2.5">2.5 seconds</option>
                        <option value="4">4 seconds</option>
                        <option value="6">6 seconds</option>
                    </select>
                </div>
                <button class="btn btn-secondary btn-sm" data-action="osd-try">Preview on open desktops</button>
            </section>

            <section data-topic="keyboard">
                <h4>Shortcuts</h4>
                <div class="trd-lead">Also listed in Tabby's <a data-action="hotkeys">Hotkeys</a>.
                    ${this.info('These work while the desktop has the keyboard. Tabby\'s other shortcuts go to the desktop then, except switching tabs and full screen.')}</div>
                <div class="trd-hotkeys" data-list="hotkeys"></div>
                <h4 style="margin-top: 24px">Keys and tips</h4>
                <table class="trd-keys"><tbody>
                    ${mac ? `
                    <tr><td>${k('⌘C')} ${k('⌘V')} ${k('⌘Z')} …</td><td>Work as on a Mac (sent as Ctrl).</td></tr>
                    <tr><td>Tap ${k('⌘')}</td><td>The Windows key (Start, or GNOME's Activities).</td></tr>
                    <tr><td>${k('⌃⌘')} + key</td><td>The Windows key with it: ${k('⌃⌘R')} for Win+R, ${k('⌃⌘E')} for Explorer.</td></tr>` : ''}
                    <tr><td>Right-click › <b>Send keys</b></td><td>Ctrl+Alt+Del, Win+L, Task Manager and others this computer keeps for itself.</td></tr>
                    <tr><td>Drop files on the desktop</td><td>Then paste them in Files or Explorer. Files copied there offer <b>Save to Downloads</b>.</td></tr>
                    <tr><td>Right-click › <b>View only</b></td><td>Watch without touching: no keys or clicks go to the desktop.</td></tr>
                    <tr><td>Right-click › <b>Save a screenshot</b></td><td>The full-resolution screen, to Downloads and the clipboard.</td></tr>
                </tbody></table>
            </section>

            <section data-topic="desktops">
                <h4>Desktops</h4>
                <div class="trd-lead">Remote desktop profiles, and desktops added from SSH tabs.
                    ${this.info('A desktop added from an SSH tab\'s menu belongs to that host. That is for hosts without a profile, such as ssh run in a local terminal.')}</div>
                <div class="trd-list" data-list="desktops"></div>
                <div class="trd-add"><button class="btn btn-secondary btn-sm" data-action="desktop">Add desktop…</button></div>
                <h4 style="margin-top: 24px">Open desktops</h4>
                <div class="trd-list" data-list="sessions"></div>
            </section>

            <section data-topic="accounts">
                <h4>Accounts</h4>
                <div class="trd-lead">Reusable sign-in details for multiple desktops.
                    ${this.info('Choose an account in a desktop\'s settings or a profile group\'s defaults.')}</div>
                <div class="trd-list" data-list="accounts"></div>
                <div class="trd-add">
                    <button class="btn btn-secondary btn-sm" data-action="account">Add an account…</button>
                    <button class="btn btn-link btn-sm" data-action="profiles">Profiles &amp; connections…</button>
                </div>
            </section>

            <section data-topic="certificates">
                <h4>Remembered certificates</h4>
                <div class="trd-list" data-list="certificates"></div>
            </section>

            <section data-topic="updates"><h4>Updates</h4><div class="trd-update" data-update></div><div data-release-settings></div></section>`

        // The sections go into the tabs' bodies; one tab shows at a time.
        const nav = this.root.querySelector('[data-nav]')!
        for (const tab of TABS) {
            const item = document.createElement('li')
            item.className = 'nav-item'
            item.innerHTML = `<a class="nav-link" data-tab="${tab.id}">${esc(tab.title)}</a>`
            item.querySelector('a')!.addEventListener('click', event => {
                event.preventDefault()
                this.showTab(tab.id)
            })
            nav.appendChild(item)
            const body = document.createElement('div')
            body.dataset.body = tab.id
            body.hidden = true
            const sections = tab.topics.map(topic => this.root.querySelector(`section[data-topic="${topic}"]`)).filter((e): e is Element => !!e)
            // The tab's name is heading enough: a section titled the same, or alone in its tab, drops its own.
            for (const section of sections) {
                const heading = section.querySelector(':scope > h4')
                if (heading && (sections.length === 1 || heading.textContent?.trim() === tab.title)) {
                    heading.remove()
                }
            }
            body.append(...sections)
            this.root.appendChild(body)
        }
        this.showTab(lastTab)
        this.root.querySelectorAll<HTMLElement>('[data-setting]').forEach(el => {
            el.addEventListener('change', () => this.zone.run(() => this.changeSetting(el)))
        })
        const resolution = this.root.querySelector<HTMLSelectElement>('[data-preview-resolution]')!
        resolution.value = previewResolution
        resolution.addEventListener('change', () => {
            previewResolution = resolution.value
            this.scalePreview()
            this.refresh()
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
            shortcuts: () => this.reveal('keyboard'),
            account: () => this.editAccount(null),
            desktop: () => this.newProfile(),
            folder: () => this.shareFolder(),
            profiles: () => this.showTabbySettings('profiles'),
            'osd-white': () => this.changeOsd({ color: '' }),
            'osd-try': () => {
                if (!this.desktop.showOsdEverywhere()) {
                    this.injector.get(NotificationsService).info('No visible desktops.')
                }
            },
        }
        this.root.querySelectorAll<HTMLElement>('[data-action]').forEach(el => el.addEventListener('click', () => {
            this.zone.run(() => actions[el.dataset.action!]?.())
        }))
        this.refresh()
    }

    /** An ⓘ placed after a description, showing `text` while hovered or focused. */
    private info (text: string): string {
        return `<span class="trd-info" tabindex="0" role="note" data-tip="${esc(text)}"><i class="fas fa-info-circle"></i></span>`
    }

    /** Sizes the preview's stage to the chosen resolution and scales it to the frame's width. */
    private scalePreview (): void {
        const frame = this.root.querySelector<HTMLElement>('.trd-osd-preview')
        const stage = frame?.querySelector<HTMLElement>('.trd-osd-stage')
        if (!frame || !stage) {
            return
        }
        const [width, height] = previewResolution.split('x').map(Number)
        stage.style.width = `${width}px`
        stage.style.height = `${height}px`
        stage.style.transform = `scale(${frame.clientWidth / width})`
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
        // Update notices and controls belong to the Updates page.
        const updates = this.injector.get(UpdateCheck)
        const banner = this.root.querySelector<HTMLElement>('[data-update]')
        if (banner) {
            banner.innerHTML = updates.available ? `<div><b>tabby-rdp ${esc(updates.available)} is available.</b> You have ${esc(installedVersion())}.</div>
                <button class="btn btn-primary btn-sm" data-upgrade>Upgrade…</button><button class="btn btn-link btn-sm" data-whatsnew>What's new</button>` : ''
            banner.querySelector('[data-upgrade]')?.addEventListener('click', () => updates.upgrade())
            banner.querySelector('[data-whatsnew]')?.addEventListener('click', () => updates.whatsNew())
        }
        renderReleaseSettings(this.root.querySelector('[data-release-settings]')!, updates, {
            notes: version => updates.whatsNew(version), plugins: () => this.help.openSettings('plugins'),
            link: url => this.platform.openExternal(url),
        })
        const osd = settings.osd
        this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-osd]').forEach(el => {
            const key = el.dataset.osd as keyof OsdSettings
            // A color input takes #rrggbb only: white stands for the default.
            el.value = key === 'color' ? (/^#[0-9a-f]{6}$/i.test(osd.color) ? osd.color : '#ffffff') : String(osd[key])
        })
        const stage = this.root.querySelector<HTMLElement>('.trd-osd-stage .trd-osd')
        if (stage) {
            renderOsd(stage, 'workstation', `via jumphost · ${previewResolution.replace('x', '×')}`, osd)
        }
        const hotkey = this.help.toggleHotkey()
        this.root.querySelectorAll<HTMLElement>('[data-hotkey]').forEach(el => {
            el.innerHTML = hotkey ? k(hotkey) : '<i>(no shortcut)</i>'
        })
        this.renderDesktops()
        this.renderHotkeys()
        this.renderAccounts()
        this.renderFolders()
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
        const accounts = this.desktop.accounts()
        const accountOf = (id: string | null | undefined) => id ? accounts.find(a => a.id === id) : undefined
        // Remote desktop profiles first (Tabby's editor), then the desktops added from SSH tabs (the plugin's form).
        const profiles: any[] = (this.config.store.profiles ?? []).filter((p: any) => p?.type === RDP_PROFILE_TYPE)
        const gatewaySignIn = (id: string | null | undefined) => {
            const account = accountOf(id)
            return account ? `, as ${esc(account.name)}` : id === ASK_GATEWAY_ACCOUNT ? ', asks for a gateway account'
                : id ? ', saved gateway account missing (asks when connecting)' : ''
        }
        // Every field as text whatever the config holds (see configText): one that can't be shown would leave this list,
        // and the lists after it on the page, unbuilt.
        const profileRows = profiles.flatMap(p => {
            const o = this.injector.get(ProfilesService).getConfigProxyForProfile(p).options
            if (!o?.host) { return [] }
            const address = `${configText(o.host)}:${configText(o.port || 3389)}`
            const via = o.via ? configText((this.config.store.profiles ?? []).find((x: any) => x.id === o.via)?.name) || 'an SSH profile' : null
            const account = accountOf(o.account)
            const clipboard = ownClipboard(o.clipboard)
            const [username, kind, gateway] = [configText(o.username), configText(o.kind), configText(o.gateway)]
            const details = [
                account ? `Signs in as ${esc(account.name)}` : username ? `Signs in as ${esc(username)}` : '',
                kind && kind !== 'windows' ? esc(kind) : '',
                gateway ? `Through the gateway ${esc(gateway)}${gatewaySignIn(o.gatewayAccount)}` : '',
                clipboard ? `Clipboard: ${esc(CLIPBOARD_LABELS[clipboard].toLowerCase())}` : '',
            ].filter(Boolean).join('<br>')
            return [this.row(esc(configText(p.name) || address), `${esc(address)}${via ? ` via ${esc(via)}` : ''}${details ? `<br>${details}` : ''}`, [
                { label: 'Edit…', run: () => { this.editProfile(p.id) } },
                { label: 'Remove…', danger: true, run: () => { this.removeProfile(p.id) } },
            ])]
        })
        const desktops = this.desktop.configuredDesktops()
        // An item that is no entry describes no desktop, and isn't listed (see isDesktopEntry).
        const desktopRows = desktops.flatMap((d, i) => {
            if (!isDesktopEntry(d)) {
                return []
            }
            // A Hyper-V VM has no address of its own: its console is its host's to give.
            const { name, address, via, hyperv } = entryText(d)
            const account = accountOf(d.account)
            const [username, kind, gateway, vm, mac] = [configText(d.username), configText(d.kind), configText(d.gateway), configText(d.wake?.vm), configText(d.wake?.mac)]
            const details = [
                account ? `Signs in as ${esc(account.name)}` : username ? `Signs in as ${esc(username)}` : '',
                kind && kind !== 'windows' ? esc(kind) : '',
                gateway && !hyperv ? `Through the gateway ${esc(gateway)}${gatewaySignIn(d.gatewayAccount)}` : '',
                vm ? `Starts VM ${esc(vm)} when off` : mac ? `Wakes ${esc(mac)} when off` : '',
                ownClipboard(d.clipboard) ? `Clipboard: ${esc(CLIPBOARD_LABELS[ownClipboard(d.clipboard)!].toLowerCase())}` : '',
            ].filter(Boolean).join('<br>')
            return [this.row(esc(name), `${hyperv ? 'Hyper-V VM' : esc(address)}${via ? ` ${hyperv ? 'on' : 'behind'} ${esc(via)}` : ''}${details ? `<br>${details}` : ''}`, [
                { label: 'Edit…', run: () => { this.desktop.editDesktopIn(this.root, i, true) } },
                { label: 'Remove…', danger: true, run: () => { this.desktop.confirmRemoveDesktop(i) } },
            ])]
        })
        list.replaceChildren(...profileRows, ...desktopRows, ...(profileRows.length + desktopRows.length ? [] : [this.empty('No saved desktops.')]))
    }

    private renderFolders (): void {
        const list = this.root.querySelector('[data-list=folders]')
        if (!list) {
            return
        }
        const folders = this.desktop.sharedFolders()
        list.replaceChildren(...folders.map((f, i) => {
            const row = this.row(esc(f.name), esc(f.path), [
                { label: 'Remove', danger: true, run: () => this.desktop.setSharedFolders(folders.filter((_, j) => j !== i)) },
            ])
            const check = document.createElement('label')
            check.className = 'trd-folder-readonly'
            check.innerHTML = '<input type="checkbox" class="form-check-input"> Read-only'
            const input = check.querySelector('input')!
            input.checked = f.readOnly
            input.addEventListener('change', () => this.zone.run(() => {
                this.desktop.setSharedFolders(folders.map((o, j) => j === i ? { ...o, readOnly: input.checked } : o))
            }))
            row.insertBefore(check, row.querySelector('button'))
            return row
        }), ...folders.length ? [] : [this.empty('No shared folders.')])
    }

    /** Asks for a folder and shares it under its own name (numbered when another share has it). */
    private async shareFolder (): Promise<void> {
        const picked = await this.platform.pickDirectory().catch(() => '')
        if (!picked) {
            return
        }
        const folders = this.desktop.sharedFolders()
        if (folders.some(f => f.path === picked)) {
            this.injector.get(NotificationsService).info('This folder is already shared.')
            return
        }
        this.desktop.setSharedFolders([...folders, { path: picked, name: driveName(basename(picked) || picked, folders), readOnly: false }])
    }

    private renderAccounts (): void {
        const list = this.root.querySelector('[data-list=accounts]')
        // The form holds what is being typed: a config change elsewhere doesn't rebuild the list under it.
        if (!list || list.querySelector('.trd-account-form')) {
            return
        }
        const accounts = this.desktop.accounts()
        // The password checks one after another: each can wait on a keychain that doesn't answer (10 s), and all at once
        // they would hold every keytar worker.
        let checks: Promise<unknown> = Promise.resolve()
        list.replaceChildren(...accounts.map(a => {
            const uses = this.desktop.accountUses(a.id)
            // Each name opens its editor: Tabby's for a profile, the plugin's form for a desktop behind an SSH host.
            const used = uses.length
                ? `Used by ${uses.map(u => u.profileId ? `<a data-profile="${esc(u.profileId)}">${esc(u.name)}</a>`
                    : u.desktopIndex !== undefined ? `<a data-desktop="${u.desktopIndex}">${esc(u.name)}</a>` : esc(u.name)).join(', ')}`
                : 'Not used'
            const row = this.row(esc(a.name), `<span>${esc(signInName(a))}</span><br><span>${used}</span><span data-password></span>`, [
                { label: 'Edit…', run: () => this.editAccount(a) },
                { label: 'Remove…', danger: true, run: () => { this.desktop.confirmRemoveAccount(a.id) } },
            ])
            row.querySelectorAll<HTMLElement>('[data-profile]').forEach(el => el.addEventListener('click', () => this.zone.run(() => this.editProfile(el.dataset.profile!))))
            row.querySelectorAll<HTMLElement>('[data-desktop]').forEach(el => el.addEventListener('click', () => this.zone.run(() => this.desktop.editDesktopIn(this.root, Number(el.dataset.desktop), true))))
            // Without a password saved, the first desktop to connect asks for it and saves it.
            checks = checks.then(() => row.isConnected ? this.desktop.accountHasPassword(a.id) : 'unknown').then(has => {
                const note = row.querySelector('[data-password]')
                if (note && has === 'no') {
                    note.innerHTML = '<br>No password saved'
                }
            }, () => null)
            return row
        }), ...accounts.length ? [] : [this.empty('No saved accounts.')])
    }

    /** The form under the list, for a new account or `account`. */
    private editAccount (account: SavedAccount | null): void {
        const list = this.root.querySelector('[data-list=accounts]')
        if (!list) {
            return
        }
        list.querySelector('.trd-account-form')?.remove()
        const form = document.createElement('form')
        form.className = 'trd-account-form'
        form.autocomplete = 'off'
        form.innerHTML = `
            <label>Name<input class="form-control" name="name" spellcheck="false" placeholder="e.g. Domain A admin"></label>
            <label>User name<input class="form-control" name="username" spellcheck="false" placeholder="e.g. adm.user, or DOMAIN\\user"></label>
            <label>Domain<input class="form-control" name="domain" spellcheck="false" placeholder="Optional"></label>
            <label>Password<input class="form-control" name="password" type="password" autocomplete="new-password"></label>
            <div class="trd-account-error"></div>
            <div class="trd-account-buttons">
                <button type="button" class="btn btn-secondary btn-sm" name="cancel">Cancel</button>
                <button type="submit" class="btn btn-primary btn-sm"></button>
            </div>`
        const field = (name: string) => form.querySelector(`[name="${name}"]`) as HTMLInputElement
        const error = form.querySelector('.trd-account-error')!
        field('name').value = account?.name ?? ''
        field('username').value = account?.username ?? ''
        field('domain').value = account?.domain ?? ''
        field('password').placeholder = account ? 'Leave empty to keep the saved password' : 'Optional; requested when connecting'
        form.querySelector('button[type=submit]')!.textContent = account ? 'Save' : 'Add'
        const close = () => {
            form.remove()
            this.renderAccounts()
        }
        field('cancel').addEventListener('click', close)
        form.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                close()
            }
        })
        form.addEventListener('submit', event => {
            event.preventDefault()
            const username = field('username').value.trim()
            const name = field('name').value.trim()
            if (!username) {
                error.textContent = 'Enter a user name.'
                field('username').focus()
                return
            }
            if (this.desktop.accounts().some(a => a.id !== account?.id && a.name.toLowerCase() === (name || username).toLowerCase())) {
                error.textContent = 'Another account has this name.'
                field('name').focus()
                return
            }
            this.zone.run(async () => {
                const saved = await this.desktop.saveAccount({ id: account?.id, name, username, domain: field('domain').value.trim() }, field('password').value)
                close()
                if (saved.keychainError) {
                    this.injector.get(NotificationsService).error(`The password wasn't saved: ${saved.keychainError}.`)
                }
            })
        })
        list.appendChild(form)
        field(account ? 'password' : 'name').focus()
    }

    /** Every hotkey Tabby knows, by id, for naming what a binding of ours collides with. */
    private hotkeyNames: Map<string, string> | null = null

    /** The bindings of a hotkey id in the config, each as its strokes (a chord is several). */
    private bindingsOf (id: string): string[][] {
        const value = this.config.store.hotkeys?.[id]
        return Array.isArray(value) ? value.map((b: string | string[]) => Array.isArray(b) ? b : [b]).filter((b: string[]) => b.length) : []
    }

    /**
     * The other hotkeys bound to the same strokes (Tabby's and this plugin's), by id. Tabby's bindings are a tree:
     * `hotkeys.profile.<id>` and `hotkeys['group-selectors'].<id>` hold bindings too, and a single binding may be a
     * string rather than a list, as Tabby's matcher reads them.
     */
    private collisions (id: string, strokes: string[]): string[] {
        const key = strokes.join(' ')
        const found: string[] = []
        const walk = (node: any, path: string) => {
            if (typeof node === 'string') {
                if (node === key) found.push(path)
            } else if (Array.isArray(node)) {
                if (node.some(b => (Array.isArray(b) ? b : [b]).join(' ') === key)) found.push(path)
            } else if (node && typeof node === 'object') {
                for (const [k, v] of Object.entries(node)) {
                    walk(v, path ? `${path}.${k}` : k)
                }
            }
        }
        walk(this.config.store.hotkeys ?? {}, '')
        return found.filter(other => other !== id)
    }

    private writeBindings (id: string, bindings: string[][]): void {
        this.config.store.hotkeys[id] = bindings.map(b => b.length === 1 ? b[0] : b)
        this.config.save()
    }

    /** The plugin's shortcuts with their bindings, as Tabby's Hotkeys page shows them: chips to change, × to remove, Add… */
    private renderHotkeys (): void {
        const list = this.root.querySelector('[data-list=hotkeys]')
        if (!list) {
            return
        }
        if (!this.hotkeyNames) {
            this.hotkeyNames = new Map()
            this.hotkeys.getHotkeyDescriptions().then((all: HotkeyDescription[]) => {
                this.hotkeyNames = new Map(all.map(h => [h.id, h.name]))
                this.renderHotkeys()
            }, () => null)
        }
        const names = this.hotkeyNames
        list.replaceChildren(...HOTKEYS.map(h => {
            const bindings = this.bindingsOf(h.id)
            const row = document.createElement('div')
            row.className = 'row align-items-center'
            row.innerHTML = '<div class="col-7 py-2 trd-hotkey-name"></div><div class="col-5 py-2"><multi-hotkey-input></multi-hotkey-input></div>'
            row.querySelector('.trd-hotkey-name')!.textContent = h.name
            const input = row.querySelector('multi-hotkey-input')!
            const conflicts: string[] = []
            bindings.forEach((strokes, i) => {
                const taken = this.collisions(h.id, strokes)
                conflicts.push(...taken.map(id => `${strokes.join(' ')} is also ${this.hotkeyName(id)}`))
                const item = document.createElement('div')
                item.className = 'item'
                const body = document.createElement('div')
                body.className = 'body'
                body.title = 'Change'
                body.append(...strokes.map(stroke => {
                    const el = document.createElement('div')
                    el.className = 'stroke'
                    el.innerHTML = `<span${taken.length ? ' class="duplicate"' : ''}></span>`
                    el.firstElementChild!.textContent = stroke
                    return el
                }))
                body.addEventListener('mousedown', event => {
                    if (event.button !== 0) return
                    this.zone.run(async () => {
                        const strokes = await this.captureFor(h.id)
                        if (strokes) {
                            const next = this.bindingsOf(h.id)
                            next[i] = strokes
                            this.writeBindings(h.id, next)
                        }
                    })
                })
                const remove = document.createElement('div')
                remove.className = 'remove'
                remove.title = 'Remove'
                remove.textContent = '×'
                remove.addEventListener('mousedown', event => {
                    if (event.button !== 0) return
                    this.zone.run(() => this.writeBindings(h.id, this.bindingsOf(h.id).filter((_, n) => n !== i)))
                })
                item.append(body, remove)
                input.appendChild(item)
            })
            const add = document.createElement('div')
            add.className = 'add'
            add.textContent = 'Add…'
            add.addEventListener('click', () => this.zone.run(async () => {
                const strokes = await this.captureFor(h.id)
                if (strokes) {
                    this.writeBindings(h.id, [...this.bindingsOf(h.id), strokes])
                }
            }))
            input.appendChild(add)
            if (conflicts.length) {
                const note = document.createElement('div')
                note.className = 'col-12 pb-2 trd-conflict'
                note.textContent = `${conflicts.join('; ')}: only one of them would act. Change one of them.`
                row.appendChild(note)
            }
            return row
        }))
    }

    /** A hotkey's name for a conflict note: one of ours by its short name, Tabby's as Tabby's Hotkeys page lists it. */
    private hotkeyName (id: string): string {
        const own = HOTKEYS.find(h => h.id === id)
        if (own) {
            return `"${own.name}" (above or below)`
        }
        // Tabby's per-profile and per-group hotkeys are keyed by the profile's or group's id.
        const profile = /^profile\.(.+)$/.exec(id)?.[1]
        const group = /^group-selectors\.(.+)$/.exec(id)?.[1]
        if (profile) {
            return `Tabby's hotkey for the profile "${(this.config.store.profiles ?? []).find((p: any) => p?.id === profile)?.name ?? profile}"`
        }
        if (group) {
            return `Tabby's hotkey for the profile group "${(this.config.store.groups ?? []).find((g: any) => g?.id === group)?.name ?? group}"`
        }
        return `Tabby's "${this.hotkeyNames?.get(id) ?? id}"`
    }

    /** Asks for a binding for one of our hotkeys, and refuses one that another hotkey has: both would fire. */
    private async captureFor (id: string): Promise<string[] | null> {
        const strokes = await this.captureHotkey()
        if (!strokes) {
            return null
        }
        const taken = this.collisions(id, strokes)
        if (taken.length) {
            this.injector.get(NotificationsService).error(`${strokes.join(' ')} is already ${taken.map(t => this.hotkeyName(t)).join(' and ')}. Choose another, or change that one first.`)
            return null
        }
        return strokes
    }

    /**
     * Tabby's "Press the key now" dialog, rebuilt in plain DOM over the page (Tabby's is not exported): the strokes
     * pressed, taken a second after the last one. Resolves with them, or null on Cancel. Tabby's hotkeys are off
     * meanwhile, so the keys pressed don't act.
     */
    private captureHotkey (): Promise<string[] | null> {
        const overlay = document.createElement('div')
        overlay.className = 'trd-capture'
        overlay.innerHTML = `<div class="trd-form-dragbar"></div><hotkey-input-modal>
            <div class="modal-header"><h5>Press the key now</h5></div>
            <div class="modal-body"><div class="input"></div><div class="timeout"><div style="width: 0%"></div></div></div>
            <div class="modal-footer"><button class="btn btn-primary" type="button">Cancel</button></div>
        </hotkey-input-modal>`
        const input = overlay.querySelector<HTMLElement>('.input')!
        const bar = overlay.querySelector<HTMLElement>('.timeout div')!
        document.body.appendChild(overlay)
        this.hotkeys.clearCurrentKeystrokes()
        this.hotkeys.disable()
        const strokes: string[] = []
        let last: number | null = null
        return new Promise<string[] | null>(resolve => {
            const keys = this.hotkeys.keyEvent$.subscribe(event => {
                event.preventDefault()
                event.stopPropagation()
            })
            const taken = this.hotkeys.keystroke$.subscribe(stroke => {
                last = performance.now()
                strokes.push(stroke)
                const el = document.createElement('div')
                el.className = 'stroke'
                el.textContent = stroke
                input.appendChild(el)
            })
            const timer = window.setInterval(() => {
                if (last === null) return
                const progress = Math.min(100, (performance.now() - last) / 10)
                bar.style.width = `${progress}%`
                if (progress === 100) done(strokes)
            }, 25)
            const done = (result: string[] | null) => {
                clearInterval(timer)
                keys.unsubscribe()
                taken.unsubscribe()
                this.hotkeys.enable()
                overlay.remove()
                resolve(result)
            }
            overlay.querySelector('button')!.addEventListener('click', () => done(null))
        })
    }

    private renderCertificates (): void {
        const list = this.root.querySelector('[data-list=certificates]')
        if (!list) {
            return
        }
        const entries = this.desktop.trustedCertificates()
        list.replaceChildren(...entries.map(({ desktop, sha256, authority }) => {
            const [who, address] = desktop.includes('#') ? desktop.split('#', 2) : [desktop, '']
            // A host's key as it reads; a machine reached through one is named as that host's ssh resolved it, which is
            // its word: what could reorder or hide part of it shows as U+FFFD.
            const host = esc(showable(shownKey(who)))
            const title = address ? who === 'gateway' ? `The gateway ${esc(address)}` : who === DIRECT_KEY ? `${esc(address)} (direct)` : `${esc(address)} behind ${host}` : host
            // How it came to be trusted, where that is known, and what else was decided about that server: forgotten with it.
            const how = authority === true ? '<br>Valid for its name by a certificate authority' : authority === false ? '<br>Trusted by you' : ''
            const plain = this.desktop.signsInWithoutNla(desktop) ? '<br>Signs in without Network Level Authentication' : ''
            return this.row(title, `SHA-256 ${esc(sha256.slice(0, 23))}…${how}${plain}`, [
                { label: 'Forget', run: () => this.desktop.forgetCertificate(desktop) },
            ])
        }), this.empty(entries.length
            ? 'A forgotten certificate is asked about again on the next connection, unless a certificate authority vouches for it; one behind an SSH host is remembered again without asking.'
            : 'No saved certificates.'))
    }

    private renderSessions (): void {
        const list = this.root.querySelector('[data-list=sessions]')
        if (!list) {
            return
        }
        const sessions = this.desktop.sessionSummaries()
        list.replaceChildren(...sessions.map(s => this.row(esc(s.name), `${s.where ? `via ${esc(s.where)} · ` : ''}${esc(s.state)}`, [
            { label: 'Copy log', run: () => this.copyLog(s.name, s.log) },
        ])), ...sessions.length ? [] : [this.empty('No desktops are open.')])
    }

    private copyLog (name: string, log: string[]): void {
        const version = installedVersion()
        this.platform.setClipboard({ text: [`tabby-rdp ${version} on ${process.platform}: ${name}`, ...this.compat.diagnosticLines(), ...log].join('\n') })
    }

    private showTab (id: string): void {
        lastTab = TABS.some(t => t.id === id) ? id : TABS[0].id
        this.root.querySelectorAll<HTMLElement>('[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === lastTab))
        this.root.querySelectorAll<HTMLElement>('[data-body]').forEach(el => { el.hidden = el.dataset.body !== lastTab })
        if (lastTab === 'updates') {
            this.injector.get(UpdateCheck).refresh()
        }
    }

    /** Shows the tab with a section (and opens a troubleshooting entry), with a short highlight. */
    private reveal (topic: HelpTopic, entry?: string): void {
        const target = (entry && this.root.querySelector<HTMLDetailsElement>(`details[data-entry="${CSS.escape(entry)}"]`))
            || this.root.querySelector<HTMLElement>(`[data-topic="${topic}"]`)
        if (!target) {
            return
        }
        this.showTab(TABS.find(t => t.topics.includes(topic))?.id ?? topic)
        if (target instanceof HTMLDetailsElement) {
            target.open = true
        }
        ;(entry ? target : this.root).scrollIntoView({ block: 'start', behavior: 'smooth' })
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

    /** Tabby's profile editor (EditProfileModalComponent), opened in Angular's zone so that it is drawn at once; null without it. */
    private openModal (): any {
        try {
            const { NgbModal } = require('@ng-bootstrap/ng-bootstrap')
            const { EditProfileModalComponent } = require('tabby-settings')
            return this.zone.run(() => this.injector.get(NgbModal).open(EditProfileModalComponent, { size: 'lg' }))
        } catch {
            return null
        }
    }

    /**
     * "Remove…" on a remote desktop profile: asks, then deletes it as Tabby's Profiles page would (a direct one's saved
     * passwords and certificate go too; see RDPProfilesService.deleteProfile).
     */
    private async removeProfile (id: string): Promise<void> {
        const profiles = this.injector.get(ProfilesService)
        const profile = (await profiles.getProfiles()).find(p => p.id === id)
        if (!profile) {
            return
        }
        const { response } = await this.platform.showMessageBox({
            type: 'warning',
            message: `Remove the profile "${profile.name}"?`,
            // A saved account isn't the profile's: other desktops may sign in with it, and it stays.
            detail: (profile.options as any)?.via
                ? 'Its saved password and remembered certificate stay: they are those of the same desktop behind its SSH profile\'s host.'
                : 'Its saved password and remembered certificate are forgotten too.',
            buttons: ['Remove', 'Keep'],
            defaultId: 1,
            cancelId: 1,
        })
        if (response !== 0) {
            return
        }
        await profiles.deleteProfile(profile)
        await this.config.save()
    }

    /** Tabby's own profile editor on an existing profile, as its Profiles page opens it; saves what comes back. */
    private async editProfile (id: string): Promise<void> {
        const profiles = this.injector.get(ProfilesService)
        const profile = (await profiles.getProfiles()).find(p => p.id === id)
        const provider = profile && profiles.providerForProfile(profile)
        // Opened inside Angular's zone: after the await above, the zone can be lost, and a modal opened outside it isn't
        // drawn until the next click, which then lands outside it and closes it.
        const modal = provider ? this.openModal() : null
        if (!modal || !profile || !provider) {
            this.showTabbySettings('profiles')
            return
        }
        modal.componentInstance.partialProfile = JSON.parse(JSON.stringify(profile))
        modal.componentInstance.profileProvider = provider
        const result = await modal.result.catch(() => null)
        if (!result) {
            return
        }
        result.type = provider.id
        await profiles.writeProfile(result)
        await this.config.save()
    }

    /** Tabby's own profile editor, for a new remote desktop profile; else its Profiles page. */
    private async newProfile (): Promise<void> {
        const profiles = this.injector.get(ProfilesService)
        const template = (await profiles.getProfiles()).find(p => p.type === RDP_PROFILE_TYPE && p.isTemplate)
        const provider = template && profiles.providerForProfile(template)
        // The group first: the editor reads its profile as soon as it opens.
        const group = provider ? await this.desktop.remoteDesktopGroup() : ''
        const modal = provider ? this.openModal() : null
        if (!modal || !template || !provider) {
            this.showTabbySettings('profiles')
            return
        }
        const { id: _id, isBuiltin: _b, isTemplate: _t, ...base } = JSON.parse(JSON.stringify(template))
        // In the plugin's group from the start, so the editor shows that group's defaults (an account, say) and a choice
        // made against them ("Ask for the account") is kept as the override it is.
        modal.componentInstance.partialProfile = { ...base, name: '', group }
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
