// VMs found on an SSH host (vms.ts), on a libvirt host that has a VM with a desktop (TRD_TEST_VM_HOST: user@host as
// this computer sees it; TRD_TEST_VM_NAME: that VM). Offered in the host's menu without any setup; VMs without a
// desktop aren't; the setting turns it off. It doesn't connect: see the windows suite for that.
import { suite } from '../lib/harness.js'
import type { DesktopSpec } from '../../src/desktops.js'

const HOST = process.env.TRD_TEST_VM_HOST
const NAME = process.env.TRD_TEST_VM_NAME
// Optionally, a running Linux VM with GNOME Remote Desktop (its RDP port answers, but its sign-in is the plugin's, over
// SSH to it): not to be offered.
const GNOME_VM = process.env.TRD_TEST_VM_GNOME

await suite('vms', async t => {
    const { ev, check } = t
    const m = /^(?:([^@]+)@)?([^@:]+)(?::(\d+))?$/.exec(HOST ?? '')
    if (!m || !NAME) {
        t.skip('vms', 'set TRD_TEST_VM_HOST (user@host with libvirt VMs) and TRD_TEST_VM_NAME (one with a desktop)')
        return
    }
    const [, user, host, port = '22'] = m
    await t.settings({ discoverVMs: true })
    check('SSH tab to the VM host connected', await ev(`H.pane = await H.openSSH({ host: ${JSON.stringify(host)}, user: ${JSON.stringify(user ?? '')}, port: ${Number(port)} }); return !!H.pane`))
    const t0 = Date.now()
    // A look that failed (the connection still settling) is kept for a minute, as for the menus: look again then.
    await ev('const target = await RD.targets.targetOf(H.pane); await RD.desktop.discoverVMs(target)')
    if (!(await ev('const target = await RD.targets.targetOf(H.pane); return RD.desktop.desktopsOf(target).some(s => s.found)'))) {
        await ev('RD.desktop.vms.delete((await RD.targets.targetOf(H.pane)).key); await RD.desktop.discoverVMs(await RD.targets.targetOf(H.pane))')
    }
    t.time('looking for VMs', Date.now() - t0)
    const found = await ev<DesktopSpec[]>('const target = await RD.targets.targetOf(H.pane); return RD.desktop.desktopsOf(target).filter(s => s.found)')
    const vm = found.find(s => s.name === NAME)
    const wake = vm?.wake
    check(`${NAME} is found`, !!vm, found)
    check('... with its address, the kind of desktop, and starting it by name', !!vm && /^\d+\.\d+\.\d+\.\d+$/.test(vm.host) && vm.port === 3389 && !!wake && 'vm' in wake && wake.vm === NAME && ['windows', 'xrdp'].includes(vm.kind), vm)
    check('only VMs with a desktop are offered (RDP answering, or Windows and shut off)', found.every(s => s.kind === 'windows' || s.found === 'running'), found.map(s => `${s.name} ${s.kind} ${s.found}`))
    if (GNOME_VM) {
        check(`${GNOME_VM} (GNOME Remote Desktop) is not offered`, !found.some(s => s.name === GNOME_VM), found.map(s => s.name))
    }
    const labels = await ev<string[]>('return (await H.menuItems(H.pane)).map(i => i.label).filter(Boolean)')
    check(`the host's menu offers it, marked as a VM`, labels.some(l => l === `Open ${NAME} (VM)` || l === `Start and open ${NAME} (VM, shut off)`), labels)

    // Optionally (TRD_TEST_VM_WAKE=1, with the VM shut off; it starts it): opening it starts it, and with "Shut down VMs
    // it started" on, that leaves the watcher on the host that shuts it down again once no desktop has been open for a
    // while (the watcher starts as soon as the VM answers, before any sign-in). How it then shuts the VM down is left to
    // a live check: it takes the whole idle time.
    if (process.env.TRD_TEST_VM_WAKE === '1' && vm) {
        const virsh = `virsh -c qemu:///system`
        const state = async () => (await t.remote('H.pane', `${virsh} domstate ${NAME} 2>&1 | head -n 1`)).trim()
        const watcher = `for d in "$HOME/.local/share/tabby-rdp" "/tmp/tabby-rdp-$(id -u)"; do f="$d/idle-${NAME}.pid"; [ -s "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && cat "$f"; done; true`
        if (await state() !== 'shut off') {
            t.skip('starting the VM and shutting it down again', `${NAME} isn't shut off`)
        } else {
            await t.settings({ shutDownIdle: 5 })
            t.onCleanup(() => t.remote('H.pane', `p=$(${watcher}); [ -n "$p" ] && kill $p; ${virsh} send-key ${NAME} KEY_LEFTSHIFT >/dev/null 2>&1; ${virsh} shutdown ${NAME} >/dev/null 2>&1; true`))
            await ev(`await H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(vm.id)}))`)
            const log = await t.waitFor<string[]>('const log = RD.desktop.logOf(H.pane); return log.some(l => /^wake: .*(shuts down after|no automatic shutdown)/.test(l)) ? log : null', 240, 1000)
            check(`opening it started ${NAME}`, await state() === 'running', log?.filter(l => /^wake:/.test(l)))
            check('... and left a watcher to shut it down after 5 minutes without a desktop', !!log?.some(l => /^wake: .* shuts down after 5 min without a desktop open/.test(l)), log?.filter(l => /^wake:/.test(l)))
            check('... which runs on the host', /^\d+$/.test((await t.remote('H.pane', watcher)).trim()))
            await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
        }
    }

    await ev('H.inZone(() => RD.desktop.updateSettings({ discoverVMs: false }))')
    const off = await ev<string[]>('return (await H.menuItems(H.pane)).map(i => i.label).filter(Boolean)')
    check('with the setting off, none are offered', !off.some(l => l.includes(NAME)), off)
})
