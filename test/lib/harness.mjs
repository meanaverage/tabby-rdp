// Shared harness for the end-to-end suites in test/suites: drives a Tabby window with tabby-rdp over the DevTools
// protocol (see test/README.md). A suite looks like:
//
//     import { suite } from '../lib/harness.mjs'
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
import { connect } from './cdp.mjs'

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Test hosts and accounts, from the environment (see test/README.md). */
export function env () {
    const e = process.env
    const host = e.TRD_TEST_HOST ?? ''
    const user = e.TRD_TEST_USER || os.userInfo().username
    const port = Number(e.TRD_TEST_PORT || 22)
    return {
        host,
        user,
        port,
        /** A private key for the SSH profile (else the SSH agent and default keys). */
        key: e.TRD_TEST_SSH_KEY || '',
        /** Destination for the system `ssh` (the local-terminal checks). */
        sshDestination: e.TRD_TEST_SSH || `${user}@${host}`,
        windows: {
            /** SSH host the Windows machine is reached through (default: TRD_TEST_HOST). */
            host: e.TRD_TEST_WIN_SSH_HOST || host,
            user: e.TRD_TEST_WIN_SSH_USER || user,
            /** RDP address as seen from that host. */
            address: e.TRD_TEST_WIN_ADDRESS || '127.0.0.1:3389',
            account: e.TRD_TEST_WIN_USER || '',
            password: e.TRD_TEST_WIN_PASSWORD || '',
            /** WinRM address as seen from that host, for checks inside Windows (optional). */
            winrm: e.TRD_TEST_WIN_WINRM || '',
            /** Python with pywinrm on that host. */
            winrmPython: e.TRD_TEST_WINRM_PYTHON || 'python3',
        },
    }
}

// Page-side helpers, installed as `window.__trd` (`H` in expressions). `config` is the test host.
const PAGE_HELPERS = config => `(() => {
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
        canvasElement (p) { return this.overlay(p)?.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas') ?? null },
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
        /** Whether the pane's desktop connected (its status line was cleared). */
        connected (p) { return RD.desktop.logOf(p).some(l => /Z $/.test(l)) },
        session (p) { return RD.desktop.sessions.get(p) },
        async menu (p) {
            const { TabContextMenuItemProvider } = require('tabby-core')
            return (await Promise.all(RD.injector.get(TabContextMenuItemProvider).map(x => x.getItems(p, false)))).flat()
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
 * Runs a suite: connects to Tabby, installs the helpers, runs `body(t)`, then cleans up and reports. Exits with 1
 * when a check failed (or the body threw).
 */
export async function suite (name, body, { needsHost = true } = {}) {
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
    const timings = []
    const cleanups = []
    const ev = expr => c.evaluate(`(async () => { const RD = window.__remoteDesktop; const H = window.__trd; ${expr} })()`)
    const t = {
        c,
        env: config,
        ev,
        sleep,
        check (label, ok, detail) {
            if (!ok) failures++
            console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`)
        },
        skip (label, why) { console.log(`SKIP  ${label}: ${why}`) },
        time (label, ms) { timings.push([label, ms]) },
        /** Runs `fn` when the suite ends (in reverse order), also after a failure. */
        onCleanup (fn) { cleanups.unshift(fn) },
        /** Polls a page expression until it is truthy (returns its value) or the time is up (null). */
        async waitFor (expr, seconds = 20, everyMs = 200) {
            for (let i = 0; i < seconds * 1000 / everyMs; i++) {
                const v = await ev(expr)
                if (v) return v
                await sleep(everyMs)
            }
            return null
        },
        /** Runs a command on the remote of `pane` (a page expression, e.g. 'H.pane'), with optional stdin. */
        remote (pane, command, stdin = '') { return ev(`return RD.execRemote(${pane}, ${JSON.stringify(command)}, ${JSON.stringify(stdin)})`) },
        /** Changes plugin settings for the suite; the previous values come back at the end. */
        async settings (change) {
            const before = await ev(`return JSON.stringify(RD.desktop.settings())`)
            t.onCleanup(() => ev(`H.inZone(() => RD.desktop.updateSettings(${before}))`))
            await ev(`H.inZone(() => RD.desktop.updateSettings(${JSON.stringify(change)}))`)
        },
        // ---- input (IronRDP sends scancodes: modifiers are real key presses) ----
        async mouse (x, y, clicks = 1) {
            await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
            for (let n = 1; n <= clicks; n++) {
                await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: n })
                await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n })
                await sleep(60)
            }
        },
        /** Clicks the remote display at (dx, dy) from its top-left corner (default: its center). */
        async clickDesktop (pane, dx, dy, clicks = 1) {
            const r = await ev(`const cv = H.canvasElement(${pane}); const r = cv.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }`)
            await t.mouse(r.x + (dx ?? r.w / 2), r.y + (dy ?? r.h / 2), clicks)
            await sleep(300)
        },
        /** Presses a key with modifiers held ('Control', 'Shift', 'Alt', 'Meta'). */
        async key (key, code, vk, mods = [], text) {
            const bits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
            const codes = { Alt: ['AltLeft', 18], Control: ['ControlLeft', 17], Meta: ['MetaLeft', 91], Shift: ['ShiftLeft', 16] }
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
        async press (ch, mods = []) {
            const upper = ch.toUpperCase()
            await t.key(mods.includes('Shift') ? upper : ch, /\d/.test(ch) ? `Digit${ch}` : `Key${upper}`, upper.charCodeAt(0), mods, ch)
        },
        /** A modifier tapped on its own. */
        async tap (modifier) {
            const codes = { Meta: ['MetaLeft', 91, 4], Control: ['ControlLeft', 17, 2], Alt: ['AltLeft', 18, 1], Shift: ['ShiftLeft', 16, 8] }
            const [code, vk, bit] = codes[modifier]
            await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: modifier, code, windowsVirtualKeyCode: vk, modifiers: bit })
            await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifier, code, windowsVirtualKeyCode: vk, modifiers: 0 })
            await sleep(40)
        },
        enter () { return t.key('Enter', 'Enter', 13, [], '\r') },
        escape () { return t.key('Escape', 'Escape', 27) },
        /** Types text: letters, digits, space and a few symbols (with Shift where the key needs it). */
        async type (text) {
            const symbols = {
                ' ': ['Space', 32], '-': ['Minus', 189], '/': ['Slash', 191], '.': ['Period', 190], ',': ['Comma', 188], '=': ['Equal', 187],
                '>': ['Period', 190, true], '$': ['Digit4', 52, true], '(': ['Digit9', 57, true], ')': ['Digit0', 48, true], '*': ['Digit8', 56, true],
                '_': ['Minus', 189, true], '"': ['Quote', 222, true], "'": ['Quote', 222],
            }
            for (const ch of text) {
                if (symbols[ch]) {
                    const [code, vk, shift] = symbols[ch]
                    await t.key(ch, code, vk, shift ? ['Shift'] : [], ch)
                } else {
                    await t.press(ch, /[A-Z]/.test(ch) ? ['Shift'] : [])
                }
            }
        },
        // ---- the Mac clipboard (shared with this machine: saved and put back) ----
        async clipboard (text) {
            if (!t._clipboardSaved) {
                t._clipboardSaved = true
                const saved = await ev('return await navigator.clipboard.readText()').catch(() => '')
                t.onCleanup(() => ev(`await navigator.clipboard.writeText(${JSON.stringify(saved)})`))
            }
            if (text !== undefined) {
                await ev(`await navigator.clipboard.writeText(${JSON.stringify(text)})`)
            }
            return ev('return await navigator.clipboard.readText()').catch(() => '')
        },
        /** Saves the remote display as <$TRD_TEST_DUMP>/<name>.png, when TRD_TEST_DUMP is set. */
        async dump (pane, name) {
            const dir = process.env.TRD_TEST_DUMP
            if (!dir) return
            const url = await ev(`return H.canvasElement(${pane})?.toDataURL('image/png') ?? ''`)
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
        console.log(`FAIL  ${name} stopped: ${e?.stack ?? e}`)
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
