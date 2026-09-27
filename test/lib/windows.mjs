// Inside the Windows test machine (TRD_TEST_WIN_*), from its SSH host: PowerShell over WinRM, and programs started in
// the signed-in session. Used by the windows and screenshots suites.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINRM_HELPER = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'winrm.py'), 'utf8')

/** Helpers bound to a suite (`t`) and the page expression of the SSH tab that reaches Windows (e.g. 'H.pane'). */
export function windowsGuest (t, pane) {
    const win = t.env.windows
    /** Runs PowerShell inside Windows (WinRM, from the SSH host). */
    const guest = script => t.remote(pane, `${win.winrmPython} -`,
        `${WINRM_HELPER}\nmain(${JSON.stringify({ address: win.winrm, user: win.account, password: win.password, script })})\n`)
    /**
     * Runs PowerShell in the signed-in Windows session, where the desktop is: a task with the account's interactive
     * token, through the Task Scheduler's COM interface (the ScheduledTasks cmdlets use WMI, which is for
     * administrators only over WinRM). The script goes as -EncodedCommand, so it needs no quoting.
     */
    const inSession = (name, script) => guest(`
$s = New-Object -ComObject Schedule.Service; $s.Connect()
$d = $s.NewTask(0)
$d.Principal.LogonType = 3
$a = $d.Actions.Create(0)
$a.Path = 'powershell.exe'
$a.Arguments = '-NoProfile -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}'
$s.GetFolder('\\').RegisterTaskDefinition('${name}', $d, 6, $null, $null, 3) | Out-Null
$s.GetFolder('\\').GetTask('${name}').Run($null) | Out-Null`)
    const dropTask = name => guest(`$s = New-Object -ComObject Schedule.Service; $s.Connect(); try { $s.GetFolder('\\').DeleteTask('${name}', 0) } catch { }`)
    /** The primary monitor's DPI in the Windows session (96 = 100%), as a DPI-aware program there sees it. */
    const dpi = async () => {
        await guest('Remove-Item "$env:TEMP\\trd-dpi.txt" -ErrorAction SilentlyContinue')
        await inSession('trd-dpi', `
Add-Type -Namespace Trd -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c); [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(long p, uint f); [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr m, int t, out uint x, out uint y);'
[Trd.Dpi]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
$x = 0; $y = 0
[Trd.Dpi]::GetDpiForMonitor([Trd.Dpi]::MonitorFromPoint(0, 1), 0, [ref]$x, [ref]$y) | Out-Null
Set-Content "$env:TEMP\\trd-dpi.txt" $x`)
        let value = ''
        for (let i = 0; i < 20 && !/^\d+$/.test(value); i++) {
            await new Promise(resolve => setTimeout(resolve, 500))
            value = (await guest('Get-Content "$env:TEMP\\trd-dpi.txt" -ErrorAction SilentlyContinue')).trim()
        }
        await dropTask('trd-dpi')
        await guest('Remove-Item "$env:TEMP\\trd-dpi.txt" -ErrorAction SilentlyContinue')
        return /^\d+$/.test(value) ? Number(value) : null
    }
    return { guest, inSession, dropTask, dpi }
}
