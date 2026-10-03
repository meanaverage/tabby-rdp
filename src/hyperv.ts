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

const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** A VM id as Hyper-V prints it, or '' if this isn't one. */
export function vmId (value: unknown): string {
    const id = String(value ?? '').trim().replace(/^\{|\}$/g, '')
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

/** The host's Hyper-V VMs, running or not (one that is off is started when opened). Read-only. */
export async function scanHyperV (target: RemoteTarget): Promise<HyperVVM[]> {
    const out = await powershell(target, SCAN)
    const found: HyperVVM[] = []
    for (const line of out.split('\n')) {
        const m = /^TRD_HV ([^|]+)\|([^|]*)\|(.+?)\s*$/.exec(line.trim())
        const id = vmId(m?.[1])
        if (m && id && !found.some(f => f.id === id)) {
            found.push({ id, name: m[3], state: m[2] === 'Running' ? 'running' : 'off' })
        }
    }
    return found
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
    const state = /^TRD_HV_STATE ([^|]*)\|(\d*)\s*$/m.exec(out)
    if (!state) {
        throw new Error(/^TRD_HV_ERR (.*)$/m.exec(out)?.[1].trim() || 'the host didn\'t answer about the VM (is PowerShell\'s Hyper-V module there, and may this account use it?)')
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
    const ok = /^TRD_HV_OK (.*)$/m.exec(out)
    if (!ok) {
        throw new Error(/^TRD_HV_ERR (.*)$/m.exec(out)?.[1].trim() || 'the host didn\'t answer')
    }
    return ok[1].trim()
}
