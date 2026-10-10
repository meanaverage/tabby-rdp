// Shared harness for the end-to-end suites in test/suites: drives a Tabby window with tabby-rdp over the DevTools
// protocol (see test/README.md). A suite looks like:
//
//     import { suite } from '../lib/harness.js'
//     await suite('name', async t => {
//         t.check('SSH tab connected', await t.ev('H.pane = await H.openSSH(); return !!H.pane'))
//         ...
//     })
//
// In page expressions (t.ev), `RD` is the plugin's test handle and `H` the page-side helpers below. Everything a
// suite opens (tabs, desktops, settings, the Mac clipboard) is put back when it ends, also on failure.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DesktopSettings } from '../../src/desktop.service.js'
import { connect, type CdpClient } from './cdp.js'

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** A key modifier, as CDP names it. */
export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

/** The Windows test machine behind the SSH host (`TRD_TEST_WIN_*`). */
export interface WindowsEnv {
    /** SSH host the Windows machine is reached through (default: TRD_TEST_HOST). */
    host: string
    user: string
    /** RDP address as seen from that host. */
    address: string
    account: string
    password: string
    /** WinRM address as seen from that host, for checks inside Windows (optional). */
    winrm: string
    /** Python with pywinrm on that host: the one provision.sh installs, if there, or python3. */
    winrmPython: string
}

/** The xrdp account on the test host (`TRD_TEST_XRDP_*`). */
export interface XrdpEnv {
    /** An account on the test host that signs in to xrdp with a password (testbed/linux/xrdp.sh). */
    user: string
    password: string
    port: number
}

/**
 * A desktop reached directly, not through SSH (`TRD_TEST_DIRECT_*`): any RDP server this machine can reach. Without
 * an address, the direct suite uses the test host's GNOME Remote Desktop.
 */
export interface DirectEnv {
    /** host[:port] (default port 3389); empty: the test host's GNOME desktop. */
    address: string
    user: string
    password: string
    /** What the server is (the plugin's desktop kind): gnome, xrdp or windows. */
    kind: string
}

/** Test hosts and accounts, from the environment (see test/README.md). */
export interface TestEnv {
    /** The Linux test host; empty skips the suites that need one. */
    host: string
    user: string
    port: number
    /** A private key for the SSH profile (else the SSH agent and default keys). */
    key: string
    /** Arguments for the system `ssh` (the local-terminal checks): a destination, possibly with options. */
    sshDestination: string
    windows: WindowsEnv
    xrdp: XrdpEnv
    direct: DirectEnv
}

/** Test hosts and accounts, from the environment (see test/README.md). */
export function env (): TestEnv {
    const e = process.env
    const host = e.TRD_TEST_HOST ?? ''
    const user = e.TRD_TEST_USER || os.userInfo().username
    const port = Number(e.TRD_TEST_PORT || 22)
    return {
        host,
        user,
        port,
        key: e.TRD_TEST_SSH_KEY || '',
        sshDestination: e.TRD_TEST_SSH || `${port !== 22 ? `-p ${port} ` : ''}${user}@${host}`,
        windows: {
            host: e.TRD_TEST_WIN_SSH_HOST || host,
            user: e.TRD_TEST_WIN_SSH_USER || user,
            address: e.TRD_TEST_WIN_ADDRESS || '127.0.0.1:3389',
            account: e.TRD_TEST_WIN_USER || '',
            password: e.TRD_TEST_WIN_PASSWORD || '',
            winrm: e.TRD_TEST_WIN_WINRM || '',
            winrmPython: e.TRD_TEST_WINRM_PYTHON || '"$(command -v /opt/tabby-rdp-test/winrm/bin/python || echo python3)"',
        },
        xrdp: {
            user: e.TRD_TEST_XRDP_USER || 'tabbyxrdp',
            password: e.TRD_TEST_XRDP_PASSWORD || '',
            port: Number(e.TRD_TEST_XRDP_PORT || 3390),
        },
        direct: {
            address: e.TRD_TEST_DIRECT || '',
            user: e.TRD_TEST_DIRECT_USER || '',
            password: e.TRD_TEST_DIRECT_PASSWORD || '',
            kind: e.TRD_TEST_DIRECT_KIND || 'gnome',
        },
    }
}

// ---- what the page-side helpers and the plugin's own objects hand back ----
//
// A page expression is a string, so nothing here can check what it returns: a suite states it (`ev<CanvasInfo>(...)`)
// and these are the shapes worth naming more than once. They describe `H` (see PAGE_HELPERS below) and the plugin's
// runtime objects (src/), as the suites read them.

/** What `H.canvas` returns: the remote display's size, its size in the pane, and how many colors a sample has. */
export interface CanvasInfo {
    /** The remote display, in its own pixels. */
    w: number
    h: number
    /** Its size on screen, in CSS pixels. */
    cssW: number
    cssH: number
    /** The pane's size, in CSS pixels. */
    paneW: number
    paneH: number
    /** How many colors a sample of it has (0: nothing drawn). */
    colors: number
    x: number
    y: number
}

/** What `H.status` returns while a desktop layer shows a message: its text and its buttons. */
export interface StatusInfo {
    text: string
    buttons: string[]
}

/** An item of a pane's menu, as `H.menu` and `H.menuItems` return it. */
export interface MenuEntry {
    label?: string
    type?: string
    checked?: boolean
    enabled?: boolean
    submenu?: MenuEntry[]
    click: () => void
}

/** What the plugin's audio player reports (src/audio.ts). */
export interface AudioStats {
    /** Seconds of audio received and scheduled. */
    received: number
    /** The loudest sample seen. */
    peak: number
}

/** What the plugin's microphone reports (src/microphone.ts), with the layer's indicator. */
export interface MicrophoneStats {
    capturing: boolean
    /** The format the server asked for, while it has the microphone open. */
    format: { sampleRate: number, channels: number } | null
    /** Seconds of audio sent. */
    sent: number
    /** Loudest sample sent, 0..1. */
    peak: number
    /** Whether the desktop layer shows its microphone indicator. */
    indicator: boolean
}

/** What the H.264 decoder reports (the vendored IronRDP web client), as the suites read it. */
export interface H264Stats {
    frames: number
    auxiliary: number
    /** Milliseconds from a frame's arrival to its pixels, for the last frame and the slowest one. */
    lastLatencyMs: number
    maxLatencyMs: number
    failed: string | null
}

/** A file the remote offered to save (src/fileTransfer.ts). */
export interface OfferedFile {
    name: string
    size: number
    isDirectory?: boolean
}

/** What `H.session` returns for a pane (src/desktop.service.ts), as the suites read it. */
export interface SessionInfo {
    h264?: H264Stats | null
    audio?: AudioStats | null
    mic?: MicrophoneStats | null
    files?: { offered?: OfferedFile[], saveAll: (dir?: string) => Promise<string[]> } | null
}

// Page-side helpers, installed as `window.__trd` (`H` in expressions). `config` is the test host.
const PAGE_HELPERS = (config: TestEnv): string => `(() => {
    const RD = window.__remoteDesktop
    const { ProfilesService, ConfigService } = require('tabby-core')
    const zone = RD.injector.get(require('@angular/core').NgZone)
    const inZone = f => zone.run(f)
    const config = RD.injector.get(ConfigService)
    const panes = () => RD.app.tabs.flatMap(t => t.getAllTabs?.() ?? [t])
    const test = ${JSON.stringify(config)}
    window.__trd = {
        inZone,
        config,
        panes,
        test,
        opened: [],
        topOf (p) { return RD.app.tabs.find(t => t === p || t.getAllTabs?.().includes(p)) },
        /** An SSH profile for the test host (or \`over\`: host, user, port, name). */
        profile (over = {}) {
            const host = over.host ?? test.host
            return {
                type: 'ssh',
                id: 'ssh:trd-test:' + host + ':' + Math.random().toString(36).slice(2, 8),
                name: over.name ?? host,
                options: {
                    host,
                    port: over.port ?? test.port,
                    user: over.user ?? test.user,
                    auth: null,
                    privateKeys: test.key ? [test.key] : [],
                    forwardedPorts: [],
                    keepaliveInterval: 5000,
                },
            }
        },
        /** Opens an SSH tab and waits for its connection (accepting a new host key). Returns the pane. */
        async openSSH (over = {}) {
            const profiles = RD.injector.get(ProfilesService)
            const before = new Set(panes())
            inZone(() => profiles.openNewTabForProfile(this.profile(over)))
            for (let i = 0; i < 160; i++) {
                const accept = [...document.querySelectorAll('ngb-modal-window button')].find(b => /Accept and remember/.test(b.innerText))
                if (accept) inZone(() => accept.click())
                const pane = panes().find(t => !before.has(t) && t.sshSession?.open)
                if (pane) {
                    this.opened.push(pane)
                    inZone(() => RD.app.selectTab(this.topOf(pane)))
                    return pane
                }
                await new Promise(r => setTimeout(r, 250))
            }
            return null
        },
        /** The terminal's text. */
        screen (p) {
            const b = p?.frontend?.xterm?.buffer?.active
            if (!b) return ''
            const lines = []
            for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
            return lines.join('\\n')
        },
        overlay (p) { return p.element.nativeElement.querySelector('.trd-overlay:not(.trd-form-overlay)') },
        canvasElement (p) { return this.overlay(p)?.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas') ?? this.overlay(p)?.querySelector('.trd-last-frame') ?? null },
        /** The remote display: size, size of the pane, and how many colors a sample of it has (0: nothing drawn). */
        canvas (p) {
            const cv = this.canvasElement(p)
            if (!cv || !cv.width) return null
            const o = this.overlay(p).getBoundingClientRect()
            const r = cv.getBoundingClientRect()
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
            const colors = new Set()
            for (let i = 0; i < d.length; i += 4 * 97) colors.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2])
            return { w: cv.width, h: cv.height, cssW: Math.round(r.width), cssH: Math.round(r.height), paneW: Math.round(o.width), paneH: Math.round(o.height), colors: colors.size, x: r.x, y: r.y }
        },
        /** The desktop layer's status message and buttons, if one shows. */
        status (p) {
            const s = this.overlay(p)?.querySelector('.trd-status')
            return s && s.style.display !== 'none' ? { text: s.querySelector('.trd-status-text').textContent, buttons: [...s.querySelectorAll('button')].map(b => b.textContent) } : null
        },
        clickStatus (p, label) { [...(this.overlay(p)?.querySelectorAll('.trd-status button') ?? [])].find(b => b.textContent === label)?.click() },
        toast (p) { return this.overlay(p)?.querySelector('.trd-toast .trd-toast-text')?.textContent ?? '' },
        /** Whether the pane's desktop connected (not just its status cleared: the sign-in form does that too). */
        connected (p) { return RD.desktop.logOf(p).some(l => /^connected: /.test(l)) },
        session (p) { return RD.desktop.sessions.get(p) },
        /** This plugin's items in a pane's menu (tab header: the tab's menu). */
        async menu (p, header = false) {
            const { TabContextMenuItemProvider } = require('tabby-core')
            const ours = RD.injector.get(TabContextMenuItemProvider).find(x => x.constructor.name === 'RemoteDesktopContextMenu')
            return ours.getItems(header ? this.topOf(p) : p, header)
        },
        /** The same, with the "Desktops" submenu's items in line. */
        async menuItems (p) {
            const items = await this.menu(p)
            return [...items, ...items.find(i => i.label === 'Desktops')?.submenu ?? []]
        },
        /** Closes what the suite opened. */
        async closeAll () {
            for (const p of this.opened) {
                try { inZone(() => RD.desktop.disconnect(p)) } catch { }
                const t = this.topOf(p)
                if (t) { try { await inZone(() => RD.app.closeTab(t, false)) } catch { } }
            }
            this.opened = []
        },
    }
})()`

/**
 * A suite's test context. `ev` and `waitFor` run a page expression and hand back what it returned: the type is the
 * caller's to state (`ev<string>(...)`), and defaults to `unknown` because nothing here can check it (`NoInfer`, so
 * that where the value goes doesn't state it instead).
 */
export interface TestContext {
    /** The DevTools session (for the CDP calls the harness doesn't wrap). */
    c: CdpClient
    env: TestEnv
    /** The platform Tabby runs on (with --port, not necessarily this machine's). */
    platform: string
    /** Runs `expr` in Tabby's page, where `RD` is the plugin's test handle and `H` the page-side helpers. */
    ev: <T = unknown>(expr: string) => Promise<NoInfer<T>>
    sleep: (ms: number) => Promise<void>
    /** Reports a check: `ok` is what the check found, `detail` what to print when it failed. */
    check: (label: string, ok: unknown, detail?: unknown) => void
    skip: (label: string, why: string) => void
    /** Records a `TIME` line for the summary. */
    time: (label: string, ms: number) => void
    /** Runs `fn` when the suite ends (in reverse order), also after a failure. */
    onCleanup: (fn: () => unknown) => void
    /** Polls a page expression until it is truthy (returns its value) or the time is up (null). */
    waitFor: <T = unknown>(expr: string, seconds?: number, everyMs?: number) => Promise<NoInfer<T> | null>
    /** A keytar call in Tabby (e.g. `getPassword('tabby-rdp', key)`); throws if the keychain doesn't answer. */
    keychain: (call: string, seconds?: number) => Promise<unknown>
    /**
     * Whether the system keychain answers (on Linux, a locked or missing keyring waits for a prompt). Found out once
     * per Tabby, since a call that never returns holds one of its few worker threads.
     */
    keychainWorks: () => Promise<boolean>
    /** A temporary folder on the machine Tabby runs on, removed when the suite ends. */
    tempDir: (prefix: string) => Promise<string>
    /** A text file on the machine Tabby runs on (null if it isn't there). */
    readFile: (file: string) => Promise<string | null>
    /** Runs a command on the remote of `pane` (a page expression, e.g. 'H.pane'), with optional stdin. */
    remote: (pane: string, command: string, stdin?: string) => Promise<string>
    /** Changes plugin settings for the suite; the previous values come back at the end. */
    settings: (change: Partial<DesktopSettings>) => Promise<void>
    /**
     * Before typing `desk` in `pane`: the plugin answers it only with the key the host's setup gave it, so this opens
     * the pane's desktop once (as a user would) and shows the console again. Needs `desk` on.
     */
    deskReady: (pane: string) => Promise<void>
    /** Clicks at page coordinates (`clicks` times). */
    mouse: (x: number, y: number, clicks?: number) => Promise<void>
    /** Clicks the remote display at (dx, dy) from its top-left corner (default: its center). */
    clickDesktop: (pane: string, dx?: number, dy?: number, clicks?: number) => Promise<void>
    /** Presses a key with modifiers held. */
    key: (key: string, code: string, vk: number, mods?: Modifier[], text?: string) => Promise<void>
    /** A letter or digit key, with modifiers. */
    press: (ch: string, mods?: Modifier[]) => Promise<void>
    /** A modifier tapped on its own. */
    tap: (modifier: Modifier) => Promise<void>
    enter: () => Promise<void>
    escape: () => Promise<void>
    /** Types text: letters, digits, space and a few symbols (with Shift where the key needs it). */
    type: (text: string) => Promise<void>
    /** Reads the Mac clipboard; with `text`, writes it first. Saved and put back when the suite ends. */
    clipboard: (text?: string) => Promise<string>
    /** Saves the remote display as <$TRD_TEST_DUMP>/<name>.png, when TRD_TEST_DUMP is set. */
    dump: (pane: string, name: string) => Promise<void>
}

/**
 * Runs a suite: connects to Tabby, installs the helpers, runs `body(t)`, then cleans up and reports. Exits with 1
 * when a check failed (or the body threw), so it never returns.
 */
export async function suite (name: string, body: (t: TestContext) => Promise<void>, { needsHost = true }: { needsHost?: boolean } = {}): Promise<never> {
    const config = env()
    if (needsHost && !config.host) {
        console.log(`SKIP  ${name}: set TRD_TEST_HOST (see test/README.md)`)
        process.exit(0)
    }
    const c = await connect()
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await c.evaluate('(async () => { for (let i = 0; i < 120 && !window.__remoteDesktop; i++) await new Promise(r => setTimeout(r, 250)); if (!window.__remoteDesktop) throw new Error("tabby-rdp is not loaded") })()')
    await c.evaluate(PAGE_HELPERS(config))

    let failures = 0
    const timings: [string, number][] = []
    const cleanups: (() => unknown)[] = []
    let clipboardSaved = false
    const ev = <T = unknown>(expr: string): Promise<T> =>
        c.evaluate<T>(`(async () => { const RD = window.__remoteDesktop; const H = window.__trd; ${expr} })()`)
    const t: TestContext = {
        c,
        env: config,
        platform: await ev<string>('return process.platform'),
        ev,
        sleep,
        check (label: string, ok: unknown, detail?: unknown) {
            if (!ok) failures++
            console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`)
        },
        skip (label: string, why: string) { console.log(`SKIP  ${label}: ${why}`) },
        time (label: string, ms: number) { timings.push([label, ms]) },
        /** Runs `fn` when the suite ends (in reverse order), also after a failure. */
        onCleanup (fn: () => unknown) { cleanups.unshift(fn) },
        /** Polls a page expression until it is truthy (returns its value) or the time is up (null). */
        async waitFor<T = unknown> (expr: string, seconds = 20, everyMs = 200): Promise<T | null> {
            for (let i = 0; i < seconds * 1000 / everyMs; i++) {
                const v = await ev<T>(expr)
                if (v) return v
                await sleep(everyMs)
            }
            return null
        },
        /** A keytar call in Tabby (e.g. `getPassword('tabby-rdp', key)`); throws if the keychain doesn't answer. */
        keychain (call: string, seconds = 10) {
            return ev(`return await Promise.race([require('keytar').${call}, new Promise((_, reject) => setTimeout(() => reject(new Error('the keychain did not answer')), ${seconds * 1000}))])`)
        },
        /**
         * Whether the system keychain answers (on Linux, a locked or missing keyring waits for a prompt). Found out once
         * per Tabby, since a call that never returns holds one of its few worker threads.
         */
        async keychainWorks () {
            const known = await ev<boolean | null>('return window.__trdKeychainWorks ?? null')
            if (known !== null) {
                return known
            }
            const probe = JSON.stringify(`trd-test-probe-${Date.now()}`)
            let works = true
            try {
                await t.keychain(`setPassword('tabby-rdp', ${probe}, 'x')`, 5)
                await t.keychain(`deletePassword('tabby-rdp', ${probe})`, 5)
            } catch {
                works = false
            }
            await ev(`window.__trdKeychainWorks = ${works}`)
            return works
        },
        /** A temporary folder on the machine Tabby runs on, removed when the suite ends. */
        async tempDir (prefix: string) {
            const dir = await ev<string>(`return require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), ${JSON.stringify(prefix)}))`)
            t.onCleanup(() => ev(`require('fs').rmSync(${JSON.stringify(dir)}, { recursive: true, force: true })`))
            return dir
        },
        /** A text file on the machine Tabby runs on (null if it isn't there). */
        readFile (file: string) { return ev<string | null>(`try { return require('fs').readFileSync(${JSON.stringify(file)}, 'utf8') } catch { return null }`) },
        /** Runs a command on the remote of `pane` (a page expression, e.g. 'H.pane'), with optional stdin. */
        remote (pane: string, command: string, stdin = '') { return ev<string>(`return RD.execRemote(${pane}, ${JSON.stringify(command)}, ${JSON.stringify(stdin)})`) },
        /** Changes plugin settings for the suite; the previous values come back at the end. */
        async settings (change: Partial<DesktopSettings>) {
            const before = await ev(`return JSON.stringify(RD.desktop.settings())`)
            t.onCleanup(() => ev(`H.inZone(() => RD.desktop.updateSettings(${before}))`))
            await ev(`H.inZone(() => RD.desktop.updateSettings(${JSON.stringify(change)}))`)
        },
        async deskReady (pane: string) {
            await ev(`await H.inZone(() => RD.desktop.showDesktop(${pane}))`)
            t.check('the desktop opened once, so desk is known there', !!(await t.waitFor(`return RD.desktop.isConnected(${pane}) || null`, 40, 100)))
            await ev(`H.inZone(() => RD.desktop.showConsole(${pane}))`)
        },
        // ---- input (IronRDP sends scancodes: modifiers are real key presses) ----
        async mouse (x: number, y: number, clicks = 1) {
            await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
            for (let n = 1; n <= clicks; n++) {
                await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: n })
                await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n })
                await sleep(60)
            }
        },
        /** Clicks the remote display at (dx, dy) from its top-left corner (default: its center). */
        async clickDesktop (pane: string, dx?: number, dy?: number, clicks = 1) {
            const r = await ev<{ x: number, y: number, w: number, h: number }>(`const cv = H.canvasElement(${pane}); const r = cv.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }`)
            await t.mouse(r.x + (dx ?? r.w / 2), r.y + (dy ?? r.h / 2), clicks)
            await sleep(300)
        },
        /** Presses a key with modifiers held ('Control', 'Shift', 'Alt', 'Meta'). */
        async key (key: string, code: string, vk: number, mods: Modifier[] = [], text?: string) {
            const bits: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
            const codes: Record<Modifier, [string, number]> = { Alt: ['AltLeft', 18], Control: ['ControlLeft', 17], Meta: ['MetaLeft', 91], Shift: ['ShiftLeft', 16] }
            let held = 0
            for (const m of mods) {
                held |= bits[m]
                await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: m, code: codes[m][0], windowsVirtualKeyCode: codes[m][1], modifiers: held })
            }
            await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers: held, ...(text && !(held & 7) ? { text } : {}) })
            await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: held })
            for (const m of [...mods].reverse()) {
                held &= ~bits[m]
                await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m, code: codes[m][0], windowsVirtualKeyCode: codes[m][1], modifiers: held })
            }
            await sleep(40)
        },
        /** A letter or digit key, with modifiers. */
        async press (ch: string, mods: Modifier[] = []) {
            const upper = ch.toUpperCase()
            await t.key(mods.includes('Shift') ? upper : ch, /\d/.test(ch) ? `Digit${ch}` : `Key${upper}`, upper.charCodeAt(0), mods, ch)
        },
        /** A modifier tapped on its own. */
        async tap (modifier: Modifier) {
            const codes: Record<Modifier, [string, number, number]> = { Meta: ['MetaLeft', 91, 4], Control: ['ControlLeft', 17, 2], Alt: ['AltLeft', 18, 1], Shift: ['ShiftLeft', 16, 8] }
            const [code, vk, bit] = codes[modifier]
            await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: modifier, code, windowsVirtualKeyCode: vk, modifiers: bit })
            await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifier, code, windowsVirtualKeyCode: vk, modifiers: 0 })
            await sleep(40)
        },
        enter () { return t.key('Enter', 'Enter', 13, [], '\r') },
        escape () { return t.key('Escape', 'Escape', 27) },
        /** Types text: letters, digits, space and a few symbols (with Shift where the key needs it). */
        async type (text: string) {
            const symbols: Record<string, [string, number, boolean?]> = {
                ' ': ['Space', 32], '-': ['Minus', 189], '/': ['Slash', 191], '.': ['Period', 190], ',': ['Comma', 188], '=': ['Equal', 187],
                '>': ['Period', 190, true], '$': ['Digit4', 52, true], '(': ['Digit9', 57, true], ')': ['Digit0', 48, true], '*': ['Digit8', 56, true],
                '_': ['Minus', 189, true], '"': ['Quote', 222, true], "'": ['Quote', 222],
            }
            for (const ch of text) {
                const symbol = symbols[ch]
                if (symbol) {
                    const [code, vk, shift] = symbol
                    await t.key(ch, code, vk, shift ? ['Shift'] : [], ch)
                } else {
                    await t.press(ch, /[A-Z]/.test(ch) ? ['Shift'] : [])
                }
            }
        },
        // ---- the Mac clipboard (shared with this machine: saved and put back) ----
        async clipboard (text?: string) {
            if (!clipboardSaved) {
                clipboardSaved = true
                const saved = await ev<string>('return await navigator.clipboard.readText()').catch(() => '')
                t.onCleanup(() => ev(`await navigator.clipboard.writeText(${JSON.stringify(saved)})`))
            }
            if (text !== undefined) {
                await ev(`await navigator.clipboard.writeText(${JSON.stringify(text)})`)
            }
            return ev<string>('return await navigator.clipboard.readText()').catch(() => '')
        },
        /** Saves the remote display as <$TRD_TEST_DUMP>/<name>.png, when TRD_TEST_DUMP is set. */
        async dump (pane: string, name: string) {
            const dir = process.env.TRD_TEST_DUMP
            if (!dir) return
            const url = await ev<string>(`return H.canvasElement(${pane})?.toDataURL('image/png') ?? ''`)
            if (url) {
                fs.mkdirSync(dir, { recursive: true })
                fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'))
            }
        },
    }

    try {
        await body(t)
    } catch (e) {
        failures++
        console.log(`FAIL  ${name} stopped: ${e instanceof Error ? e.stack : e}`)
    } finally {
        for (const fn of cleanups) {
            try { await fn() } catch { }
        }
        try { await ev('await H.closeAll()') } catch { }
        c.close()
    }
    for (const [label, ms] of timings) {
        console.log(`TIME  ${label}: ${ms} ms`)
    }
    console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
    process.exit(failures ? 1 : 0)
}
