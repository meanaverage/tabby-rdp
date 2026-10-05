import { RemoteTarget } from './targets'

/**
 * Hyper-V VMs on a Windows SSH host. Their consoles are reached through the host, as Hyper-V Manager's Connect does:
 * RDP to the host's port 2179 with the VM's id sent first (a pre-connection blob), signed in to with an account of
 * the host that may open the VM (an administrator, a Hyper-V administrator, or one granted with
 * Grant-VMConnectAccess). No network is needed inside the VM. PowerShell on the host lists them, says how one is, and
 * starts it.
 */
export interface HyperVVM {
    /** The VM's id (a GUID), which names it to the host's port 2179. */
    id: string
    name: string
    state: 'running' | 'off'
}

/** VMConnect's port on a Hyper-V host. */
export const HYPERV_PORT = 2179

/**
 * How many VMs a host's scan lists at most (see vms.ts too). Each is a menu item, and an answer of the host's making
 * could otherwise make thousands of them. A host can have more (a Hyper-V server can run 1,024): the first ones are
 * listed, and the menu says that only so many are (see RemoteDesktopService.vmsCut).
 */
export const MAX_VMS = 256

const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** A VM id as Hyper-V prints it, or '' if this isn't one. */
export function vmId (value: unknown): string {
    // Text only: String() of an object from the config runs its own conversions, which can throw.
    const id = (typeof value === 'string' ? value : '').trim().replace(/^\{|\}$/g, '')
    return GUID.test(id) ? id.toLowerCase() : ''
}

/**
 * Runs a PowerShell script on the host and returns what it printed. As -EncodedCommand, which reads the same whether
 * the host's SSH shell is cmd.exe or PowerShell, and needs no quoting. Windows PowerShell 5.1 is on every Windows.
 */
async function powershell (target: RemoteTarget, script: string): Promise<string> {
    const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64')
    return target.exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, '')
}

// One line per VM: TRD_HV <id>|<state>|<name>. Nothing where Hyper-V isn't installed or the account may not list
// VMs (which takes an administrator of the host, in practice).
const SCAN = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
if (Get-Command Get-VM) { Get-VM | ForEach-Object { 'TRD_HV ' + $_.Id + '|' + $_.State + '|' + $_.Name } }
`

/**
 * A line of the scan's answer longer than this is none of its own: its id and state take some 50 characters, and
 * Hyper-V keeps a VM's name to 100.
 */
const MAX_LINE = 1024

/**
 * A line of the scan's answer, `TRD_HV <id>|<state>|<name>` (the name may hold bars), as a VM; null for any other line.
 * Read by where its bars are, not with a pattern whose parts can take the same characters: a long line of the host's
 * making could make that cost the square of its length.
 */
function scannedVM (raw: string): HyperVVM | null {
    const line = raw.length > MAX_LINE ? '' : raw.trim()
    const first = line.indexOf('|')
    const second = first < 0 ? -1 : line.indexOf('|', first + 1)
    if (!line.startsWith('TRD_HV ') || second < 0) {
        return null
    }
    const id = vmId(line.slice('TRD_HV '.length, first))
    const name = line.slice(second + 1)
    // A name on one line, as PowerShell prints it.
    if (!id || !name || /[\r\u2028\u2029]/.test(name)) {
        return null
    }
    return { id, name, state: line.slice(first + 1, second) === 'Running' ? 'running' : 'off' }
}

/**
 * The host's Hyper-V VMs, running or not (one that is off is started when opened), MAX_VMS at most; `listed.cut` says
 * whether the host has more. Read-only.
 */
export async function scanHyperV (target: RemoteTarget, listed: { cut?: boolean } = {}): Promise<HyperVVM[]> {
    const out = await powershell(target, SCAN)
    const found: HyperVVM[] = []
    listed.cut = false
    // Ids seen so far: looked up, not searched for, so that the time taken grows with the lines, not their square.
    const ids = new Set<string>()
    for (const line of out.split('\n')) {
        const vm = scannedVM(line)
        if (vm && !ids.has(vm.id)) {
            // One more than are listed: the list is cut short.
            if (found.length === MAX_VMS) {
                listed.cut = true
                break
            }
            ids.add(vm.id)
            found.push(vm)
        }
    }
    return found
}

/**
 * What follows `prefix` on each line of the host's answer that starts with it, trimmed, and MAX_LINE characters of it
 * at most (the host's reason for an error is shown as it is). Line by line: a pattern run over the whole answer can
 * match across its lines, which a long answer of the host's making can make cost the square of its length.
 */
function linesAfter (out: string, prefix: string): string[] {
    return out.split('\n').map(line => line.trim()).filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim().slice(0, MAX_LINE))
}

// TRD_HV_STATE <state>|<enhanced session mode state>, or TRD_HV_ERR <why>. The enhanced state is
// Msvm_ComputerSystem's: 2 when the guest takes enhanced sessions right now (the host allows them, and the guest's
// Remote Desktop Services answer on its bus), anything else when only the basic console is there.
const STATE = String.raw`
try {
    $vm = Get-VM -Id '@@ID@@' -ErrorAction Stop
    $enhanced = (Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "Name='$($vm.Id.ToString().ToUpper())'" -ErrorAction SilentlyContinue).EnhancedSessionModeState
    'TRD_HV_STATE ' + $vm.State + '|' + $enhanced
} catch { 'TRD_HV_ERR ' + ($_.Exception.Message -replace '\s+', ' ') }
`

/** How a VM is now: running or not, and whether it takes an enhanced session. Throws with the host's reason when it can't say. */
export async function hyperVState (target: RemoteTarget, id: string): Promise<{ running: boolean, enhanced: boolean }> {
    const out = await powershell(target, STATE.replace('@@ID@@', vmId(id)))
    const state = linesAfter(out, 'TRD_HV_STATE ').map(line => /^([^|]*)\|(\d*)$/.exec(line)).find(Boolean)
    if (!state) {
        throw new Error(linesAfter(out, 'TRD_HV_ERR ')[0] || 'the host didn\'t answer about the VM (is PowerShell\'s Hyper-V module there, and may this account use it?)')
    }
    return { running: state[1] === 'Running', enhanced: state[2] === '2' }
}

const START = String.raw`
try {
    $vm = Get-VM -Id '@@ID@@' -ErrorAction Stop
    if ($vm.State -eq 'Running') { 'TRD_HV_OK ' + $vm.Name + ' is already running' }
    elseif ($vm.State -eq 'Paused') { Resume-VM -VM $vm -ErrorAction Stop; 'TRD_HV_OK ' + $vm.Name + ' resumed' }
    else { Start-VM -VM $vm -ErrorAction Stop; 'TRD_HV_OK ' + $vm.Name + ' started' }
} catch { 'TRD_HV_ERR ' + ($_.Exception.Message -replace '\s+', ' ') }
`

/** Starts (or resumes) the VM. Resolves with what was done; throws with the host's reason when it couldn't. */
export async function startHyperV (target: RemoteTarget, id: string): Promise<string> {
    const out = await powershell(target, START.replace('@@ID@@', vmId(id)))
    const ok = linesAfter(out, 'TRD_HV_OK ')
    if (!ok.length) {
        throw new Error(linesAfter(out, 'TRD_HV_ERR ')[0] || 'the host didn\'t answer')
    }
    return ok[0]
}
