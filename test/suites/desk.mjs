// `desk`, on a Linux desktop host (TRD_TEST_HOST): SSH logins run in a shared session (TRD_TEST_BACKEND=native,
// trd-pty, the default; or tmux); `desk` shows the desktop with a terminal attached to that same session; typing
// there lands in the console; RDP and SSH disconnects keep the session; turning `desk` off removes the login hook
// and turning it on again restores it, leaving ~/.bashrc as it was.
import { suite } from '../lib/harness.mjs'

const BACKEND = process.env.TRD_TEST_BACKEND === 'tmux' ? 'tmux' : 'native'
const HOME = '~/.local/share/tabby-rdp'

await suite('desk', async t => {
    const { ev, check, sleep } = t
    const connected = async pane => !!(await t.waitFor(`const l = RD.desktop.logOf(${pane}).at(-1) ?? ''; return /Z $/.test(l) || /failed|ended/.test(l) ? /Z $/.test(l) : null`, 40, 100))
    const clientsOf = async (pane, id) => Number((BACKEND === 'native'
        ? await t.remote(pane, `${HOME}/bin/trd-pty clients ${id}`)
        : await t.remote(pane, `tmux -L tabby list-sessions -F '#{session_name} #{session_attached}' | awk '$1 == "${id}" { print $2 }'`)).trim() || 0)
    // Desktop terminals keep shared sessions alive; end them. ([t] keeps pkill from matching this command itself.)
    const endSessions = `pkill -u "$(id -u)" -f '[t]rd-pty attach'; tmux -L tabby kill-server 2>/dev/null; true`
    console.log(`backend: ${BACKEND}`)
    await ev(`H.inZone(() => RD.injector.get(require('tabby-core').ConfigService).store.remoteDesktop.sessionBackend = ${JSON.stringify(BACKEND)})`)
    await t.settings({ desk: true })

    // 1. A first connection records the backend and installs the login hook, `desk` and trd-pty.
    check('SSH tab connected', await ev('H.a = await H.openSSH(); return !!H.a'))
    await t.remote('H.a', endSessions)
    t.onCleanup(() => ev('H.a && RD.execRemote(H.a, ' + JSON.stringify(endSessions) + ')'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.a))')
    check('desktop connected (setup ran)', await connected('H.a'))
    const installed = await t.remote('H.a', `cd ${HOME} && test -x bin/desk && test -x bin/trd-pty && cat backend && grep -c '# tabby-rdp$' ~/.bashrc`)
    check(`backend "${BACKEND}" recorded, desk and trd-pty installed, ~/.bashrc hooked once`, installed.trim() === `${BACKEND}\n1`, installed)
    await ev('H.inZone(() => RD.desktop.disconnect(H.a))')

    // 2. A new SSH login runs inside the shared session.
    check('second SSH tab connected', await ev('H.b = await H.openSSH(); return !!H.b'))
    await sleep(3000)
    // Short fields only: a long line would wrap in the terminal and cut the parse.
    await ev(`H.b.sendInput('clear; echo "trd:$(tmux display -p "#S" 2>/dev/null):$TRD_SESSION:\${TMUX:+in-tmux}:$(command -v desk >/dev/null && echo desk-ok)"\\r')`)
    await sleep(1500)
    const info = (await ev('return H.screen(H.b)')).split('\n').filter(l => /^trd:/.test(l)).pop() ?? ''
    const [, tmuxName, trdSession, tmuxVar, deskPath] = info.split(':')
    const sessionId = BACKEND === 'native' ? trdSession : tmuxName
    check(`the login shell runs in the ${BACKEND} session, with desk on PATH`,
        (BACKEND === 'native' ? /^[0-9a-f]{8}$/.test(trdSession) && !tmuxVar : tmuxVar === 'in-tmux' && !!tmuxName) && /^desk-ok/.test(deskPath ?? ''), info)
    if (BACKEND === 'native') {
        const tmux = (await t.remote('H.b', `pgrep -u "$(id -u)" -x tmux; tmux -L tabby ls 2>&1 | head -1`)).trim()
        check('no tmux involved (no tmux process or tabby server)', !/^\d+$/m.test(tmux), tmux)
    }
    check('the console is the one attached terminal', await clientsOf('H.b', sessionId) === 1)

    // 3. `desk`: the desktop, with a terminal attached to the same session.
    await ev('H.b.sendInput("clear; echo before-desk-$((6*7))\\r")')
    await sleep(800)
    const t0 = Date.now()
    await ev(`H.b.sendInput('desk\\r')`)
    check('desk shows the desktop', await connected('H.b') && await ev('return RD.desktop.isVisible(H.b)'))
    t.time('desk → desktop connected', Date.now() - t0)
    let clients = 0
    for (let i = 0; i < 100 && clients < 2; i++) {
        clients = await clientsOf('H.b', sessionId)
        if (clients < 2) await sleep(100)
    }
    t.time('desk → desktop terminal attached', Date.now() - t0)
    check('a desktop terminal attached to the console session', clients === 2, clients)
    check('desk leaves no escape sequence on screen', !(await ev('return H.screen(H.b)')).includes('7777'))
    check('desk logged', await ev('return RD.desktop.logOf(H.b).some(l => /desk: opened/.test(l))'), await ev('return RD.desktop.logOf(H.b)'))

    // 4. Typing in the desktop terminal reaches the same shell, once, and both views show it.
    await sleep(1000)
    await t.clickDesktop('H.b')
    const marker = `/tmp/trd-desk-${Date.now()}`
    await t.remote('H.b', `rm -f ${marker}`)
    await t.type(`echo deskok42 >> ${marker}`)
    await t.enter()
    await t.type('echo deskok42')
    await t.enter()
    await sleep(1500)
    const written = (await t.remote('H.b', `cat ${marker} 2>/dev/null; rm -f ${marker}`)).trim()
    check('desktop typing reached the shell exactly once', written === 'deskok42', written)
    // tmux draws the console at the desktop terminal's size while that is the latest client, padding with '·'.
    const behind = await ev('return H.screen(H.b)')
    check('the console (attached behind the desktop) shows it live', /^deskok42(?![\w/])/m.test(behind),
        behind.split('\n').filter(l => /deskok42/.test(l)).map(l => l.slice(0, 60)))
    await ev('H.inZone(() => RD.desktop.showConsole(H.b))')
    check('back on the console: same session, output there', !!(await t.waitFor(`return /^deskok42\\s*$/m.test(H.screen(H.b))`, 3, 300)))

    // 5. An RDP disconnect and reconnect keeps the desktop terminal and the session.
    await ev('H.inZone(() => RD.desktop.disconnect(H.b))')
    await sleep(1000)
    check('RDP disconnect: session and desktop terminal remain', await clientsOf('H.b', sessionId) === 2)
    const r0 = Date.now()
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.b))')
    check('RDP reconnect', await connected('H.b'))
    t.time('desktop reconnect', Date.now() - r0)
    await ev('H.b.sendInput("echo after-reconnect-$((6*7))\\r")')
    check('console input still reaches the session', !!(await t.waitFor(`return /after-reconnect-42/.test(H.screen(H.b))`, 3, 300)))

    // 6. An SSH (console) disconnect keeps the session alive in the desktop terminal. Tabby shares one SSH
    //    connection between tabs to the same host and only closes a tab's shell with the connection, so disconnect
    //    for real: close every tab to the host, then look from a fresh login.
    await ev('H.inZone(() => RD.desktop.disconnect(H.b))')
    await ev(`for (const p of [H.a, H.b]) { const top = H.topOf(p); if (top) await H.inZone(() => RD.app.closeTab(top, false)) }`)
    await sleep(2000)
    check('fresh SSH tab after the disconnect', await ev('H.a = await H.openSSH(); return !!H.a'))
    const waitClients = async n => {
        let count = -1
        for (let i = 0; i < 24 && count !== n; i++) {
            await sleep(250)
            count = await clientsOf('H.a', sessionId)
        }
        return count
    }
    let after = await waitClients(1)
    check('SSH disconnect: the session lives on in the desktop terminal', after === 1, after)
    await t.remote('H.a', endSessions)
    after = await waitClients(0)
    check('closing the last terminal ends the session', after === 0, after)

    // 7. Turning `desk` off removes the hook and helpers on the next connect; turning it on brings them back.
    const hookState = async () => (await t.remote('H.a', `grep -c '# tabby-rdp$' ~/.bashrc; test -x ${HOME}/bin/desk && echo desk || echo no-desk`)).trim()
    const rcSize = async () => (await t.remote('H.a', 'wc -c < ~/.bashrc')).trim()
    const sizeBefore = await rcSize()
    await ev('H.inZone(() => RD.desktop.updateSettings({ desk: false }))')
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.a))')
    check('desk off: desktop connects', await connected('H.a'))
    check('desk off: the ~/.bashrc hook and desk are removed', await hookState() === '0\nno-desk', await hookState())
    await ev('H.inZone(() => RD.desktop.disconnect(H.a))')
    await ev('H.inZone(() => RD.desktop.updateSettings({ desk: true }))')
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.a))')
    check('desk on again: desktop connects', await connected('H.a'))
    check('desk on again: hook (once) and desk are back', await hookState() === '1\ndesk', await hookState())
    const sizeAfter = await rcSize()
    check('off and on again leaves ~/.bashrc as it was', sizeAfter === sizeBefore, { sizeBefore, sizeAfter })
})
