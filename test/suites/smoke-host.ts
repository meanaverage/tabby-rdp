// Host upgrade checks with real Tabby, xterm, local PTYs and plugin settings. No remote desktop is required.
import { profileValidationSmoke } from '../lib/profile-validation-smoke.js'
import { suite } from '../lib/harness.js'
import { rendererErrors, smokeHost } from '../lib/smoke.js'

interface ModalDrag { bars: number, native: boolean, hit: boolean, controls: boolean }

await suite('smoke-host', async t => {
    const { ev, check, waitFor } = t
    await smokeHost(t)
    const errors = await rendererErrors(t)
    const directory = await t.tempDir('trd-smoke-shell-')
    const terminalConfig = await ev<string>('return JSON.stringify(H.config.store.terminal)')
    t.onCleanup(() => ev(`H.config.store.terminal = ${terminalConfig}; H.config.save()`))
    // xterm 5's macOS Option keys send text only with this setting enabled; use an explicit test setting.
    await ev('H.config.store.terminal.altIsMeta = true; await H.config.save()')
    check('plugin terminal decorators are registered with the host', await ev(`
        const decorators = RD.injector.get(require('tabby-terminal').TerminalDecorator).map(d => d.constructor.name);
        return ['RemoteDesktopToolbarButton', 'DeskTriggerDecorator', 'RDPProfileOpener'].every(n => decorators.includes(n));
    `))
    t.onCleanup(() => ev(`const s = RD.app.tabs.find(x => x instanceof require('tabby-settings').SettingsTabComponent); if (s) await H.inZone(() => RD.app.closeTab(s, false))`))
    await ev(`Object.assign(H, {
        async smokeLocal () {
            const before = new Set(H.panes());
            const windows = process.platform === 'win32';
            await H.inZone(() => RD.injector.get(require('tabby-core').ProfilesService).openNewTabForProfile({
                id: 'local:trd-smoke:' + Math.random().toString(36).slice(2), type: 'local', name: 'Host smoke',
                options: { command: windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/bash',
                    args: windows ? ['/d', '/q'] : ['--noprofile', '--norc'], cwd: ${JSON.stringify(directory)},
                    env: { HISTFILE: windows ? 'NUL' : '/dev/null', PS1: 'trd-smoke> ', PROMPT_COMMAND: '', BASH_ENV: '' },
                    shellType: windows ? 'cmd' : 'unix' }
            }));
            for (let i = 0; i < 80; i++) {
                const pane = H.panes().find(p => !before.has(p) && p.profile?.type === 'local');
                if (pane) {
                    if (!H.opened.includes(pane)) H.opened.push(pane);
                    H.inZone(() => RD.app.selectTab(H.topOf(pane)));
                    if (pane.session?.open && pane.frontend?.xterm?.rows > 0) return pane;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error('The local smoke terminal did not become ready');
        },
        smokeSize () { const x = H.local.frontend.xterm; return { cols: x.cols, rows: x.rows }; },
        smokeResize (width, height) {
            const el = H.local.element.nativeElement;
            el.style.flex = 'none'; el.style.minWidth = '0'; el.style.width = width + 'px'; el.style.height = height + 'px';
        }
    })`)

    // Both choices: xterm 5 uses canvas for "xterm"; xterm 6 uses DOM. No renderer implementation is assumed.
    for (const frontend of ['xterm', 'xterm-webgl']) {
        await ev(`H.config.store.terminal.frontend = ${JSON.stringify(frontend)}; await H.config.save(); H.local = await H.smokeLocal()`)
        check(`${frontend}: terminal input can take focus`, await ev(`H.local.frontend.focus(); const input = H.local.element.nativeElement.querySelector('textarea.xterm-helper-textarea'); return !!input && !input.disabled && document.activeElement === input`))
        check(`${frontend}: shared compatibility reports this pane's input`, await ev('return RD.compat.snapshot(H.local.element.nativeElement).capabilities.terminalInput === true'))
        await ev('H.local.frontend.focus()')
        await t.type('echo SMOKE_CONSOLE_OK')
        await t.enter()
        check(`${frontend}: real keystrokes reach the local PTY`, !!await waitFor('return /^SMOKE_CONSOLE_OK\\s*$/m.test(H.screen(H.local))', 5))

        // Host shortcuts can bypass frontend.input$; observe everything actually sent to the PTY.
        await ev(`H.smokeInput = []; H.smokeInputSub = H.local.session.middleware.outputToSession$.subscribe(b => H.smokeInput.push(Buffer.from(b).toString('hex')))`)
        t.onCleanup(() => ev('H.smokeInputSub?.unsubscribe()'))
        await t.key('ArrowLeft', 'ArrowLeft', 37, ['Alt'])
        await t.key('ArrowRight', 'ArrowRight', 39, ['Alt'])
        const keys = await ev<string[]>('return H.smokeInput')
        const expected = t.platform === 'darwin' ? ['1b62', '1b66'] : ['1b5b313b3544', '1b5b313b3543']
        check(`${frontend}: Alt+arrows keep the host's word-jump sequences`, expected.every(k => keys.includes(k)), { expected, actual: keys })
        await ev('H.smokeInputSub.unsubscribe()')

        await ev('H.smokeResize(600, 360)')
        await t.sleep(500)
        const small = await ev<{ cols: number, rows: number }>('return H.smokeSize()')
        await ev('H.smokeResize(760, 450)')
        check(`${frontend}: resize fits a larger pane`, !!await waitFor(`const s = H.smokeSize(); return s.cols > ${small.cols} && s.rows > ${small.rows}`, 5), small)
        await ev(`H.local.session.emitOutput(Buffer.from(Array.from({ length: 80 }, (_, i) => 'SMOKE_SCROLL_' + i + '\\r\\n').join('')))`)
        check(`${frontend}: output drains through the session middleware`, !!await waitFor('return H.screen(H.local).includes("SMOKE_SCROLL_79")', 5))
        await ev('H.local.frontend.scrollToTop()')
        const font = await ev<{ size: number, rows: number }>('return { size: H.local.frontend.xterm.options.fontSize, rows: H.local.frontend.xterm.rows }')
        await ev('H.config.store.terminal.fontSize += 2; await H.config.save(); H.local.configure()')
        check(`${frontend}: font change updates terminal geometry`, !!await waitFor(`const x = H.local.frontend.xterm; return x.options.fontSize > ${font.size} && x.rows < ${font.rows}`, 5), font)
        check(`${frontend}: font change preserves unpinned scroll position`, await ev('return H.local.frontend.xterm.buffer.active.viewportY === 0'), await ev('const b = H.local.frontend.xterm.buffer.active; return { viewport: b.viewportY, bottom: b.baseY }'))
        await ev('H.local.frontend.scrollToBottom()')
        check(`${frontend}: scrolling returns to the last output`, !!await waitFor('const b = H.local.frontend.xterm.buffer.active; return b.viewportY === b.baseY && H.screen(H.local).includes("SMOKE_SCROLL_79")', 5))
        await ev('H.config.store.terminal.fontSize -= 2; await H.config.save(); H.local.configure()')

        // The pane loses focus to settings, then becomes active again: output and keyboard must recover.
        await ev(`RD.help.open('settings'); H.local.session.emitOutput(Buffer.from('SMOKE_BACKGROUND\\r\\n'))`)
        await waitFor('return !!document.querySelector(".trd-settings")', 5)
        await ev('H.inZone(() => RD.app.selectTab(H.topOf(H.local)))')
        check(`${frontend}: background output survives tab switching`, !!await waitFor('return H.screen(H.local).includes("SMOKE_BACKGROUND")', 5))
        await ev('H.local.frontend.focus()')
        check(`${frontend}: console focus returns after switching tabs`, await ev('return document.activeElement === H.local.element.nativeElement.querySelector("textarea.xterm-helper-textarea")'))
        await ev('H.closedLocal = H.local; await H.inZone(() => RD.app.closeTab(H.topOf(H.local), false))')
        check(`${frontend}: closing removes the pane and plugin overlay`, !!await waitFor('return !H.panes().includes(H.closedLocal) && !H.closedLocal.element.nativeElement.isConnected && !RD.desktop.has(H.closedLocal)', 5))
    }

    // Settings and the real RDP profile editor expose host Angular/DI and modal integration changes.
    await ev(`RD.help.open('accounts')`)
    check('plugin settings open', !!await waitFor('return !!document.querySelector(".trd-settings [data-action=account]")', 5))
    await ev(`document.querySelector('.trd-settings [data-action=account]').click(); const f = document.querySelector('.trd-account-form'); f.querySelector('[name=name]').value = 'Smoke dummy'; f.querySelector('[name=username]').value = 'dummy'; f.querySelector('[name=password]').value = 'dummy-only'; f.requestSubmit()`)
    check('account saves a revision using dummy credentials', !!await waitFor('return RD.desktop.accounts().some(a => a.name === "Smoke dummy" && /^[0-9a-f-]{36}$/.test(a.credentialRevision ?? ""))', 5))
    t.onCleanup(() => ev(`const a = RD.desktop.accounts().find(a => a.name === 'Smoke dummy'); if (a) await RD.desktop.removeAccount(a.id)`))
    const spacing = await ev<string>('return document.documentElement.style.getPropertyValue("--spaciness")')
    t.onCleanup(() => ev(`document.documentElement.style.setProperty('--spaciness', ${JSON.stringify(spacing)})`))
    t.onCleanup(() => ev(`H.inZone(() => RD.injector.get(require('@ng-bootstrap/ng-bootstrap').NgbModal).dismissAll())`))
    for (const value of ['1', '0.75']) {
        await ev(`document.documentElement.style.setProperty('--spaciness', ${JSON.stringify(value)}); RD.help.open('desktops')`)
        await waitFor('return !!document.querySelector(".trd-settings [data-action=desktop]")', 5)
        await ev(`H.inZone(() => document.querySelector('.trd-settings [data-action=desktop]').click())`)
        const modal = await waitFor('return !!document.querySelector(".modal rdp-profile-settings")', 5)
        if (!modal) throw new Error('RDP profile editor did not open')
        await t.sleep(100)
        const drag = await ev<ModalDrag>(`
            const m = document.querySelector('.modal'), bar = m.querySelector(':scope > .trd-form-dragbar');
            const s = getComputedStyle(m, '::before'), native = s.content !== 'none' && s.content !== 'normal' &&
                s.display !== 'none' && s.getPropertyValue('-webkit-app-region') === 'drag' && parseFloat(s.height) > 4;
            const input = m.querySelector('input'); input.focus();
            return { bars: m.querySelectorAll(':scope > .trd-form-dragbar').length, native,
                hit: native ? document.elementFromPoint(4, 4) === m : !!bar && getComputedStyle(bar).getPropertyValue('-webkit-app-region') === 'drag' && document.elementFromPoint(4, 4) === bar,
                controls: document.activeElement === input };
        `)
        check(`modal spacing ${value}: one effective drag region and usable controls`, drag.hit && drag.controls && drag.bars === (drag.native ? 0 : 1), drag)
        check(`modal spacing ${value}: shared compatibility records the observed host capability`, await ev(`return RD.compat.snapshot().capabilities.nativeModalDragRegion === ${drag.native}`))
        check('profile editor offers the saved account', await ev(`return [...document.querySelectorAll('.modal rdp-profile-settings [name=account] option')].some(o => /Smoke dummy/.test(o.textContent))`))
        await ev(`H.inZone(() => RD.injector.get(require('@ng-bootstrap/ng-bootstrap').NgbModal).dismissAll())`)
        await waitFor('return !document.querySelector(".modal")', 5)
        if (value === '0.75') { await profileValidationSmoke(t) }
    }
    await ev(`RD.help.open('keyboard')`)
    await waitFor('return !!document.querySelector(".trd-settings [data-list=hotkeys] .add")', 5)
    await ev(`document.querySelector('.trd-settings [data-list=hotkeys] .add').click()`)
    await waitFor('return !!document.querySelector(".trd-capture")', 5)
    t.onCleanup(() => ev('document.querySelector(".trd-capture button")?.click()'))
    check('plugin hotkey overlay keeps its own drag region', await ev(`const bar = document.querySelector('.trd-capture > .trd-form-dragbar'); return !!bar && getComputedStyle(bar).getPropertyValue('-webkit-app-region') === 'drag' && document.elementFromPoint(4, 4) === bar`))
    await ev('document.querySelector(".trd-capture button").click()')
    errors()
}, { needsHost: false })
