// Inside the Windows test machine (TRD_TEST_WIN_*), from its SSH host: PowerShell over WinRM, and programs started in
// the signed-in session. Used by the windows and screenshots suites.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from './harness.js'

const WINRM_HELPER = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'winrm.py'), 'utf8')

/** The Windows test machine, as a suite reaches it. */
export interface WindowsGuest {
    /** Runs PowerShell inside Windows (WinRM, from the SSH host). */
    guest: (script: string) => Promise<string>
    /** Runs PowerShell in the signed-in Windows session, where the desktop is. */
    inSession: (name: string, script: string) => Promise<string>
    /** Removes a task `inSession` registered. */
    dropTask: (name: string) => Promise<string>
    /** The primary monitor's DPI in the Windows session (96 = 100%), as a DPI-aware program there sees it. */
    dpi: () => Promise<number | null>
}

/** Helpers bound to a suite (`t`) and the page expression of the SSH tab that reaches Windows (e.g. 'H.pane'). */
export function windowsGuest (t: TestContext, pane: string): WindowsGuest {
    const win = t.env.windows
    const guest = (script: string) => t.remote(pane, `${win.winrmPython} -`,
        `${WINRM_HELPER}\nmain(${JSON.stringify({ address: win.winrm, user: win.account, password: win.password, script })})\n`)
    /**
     * Runs PowerShell in the signed-in Windows session, where the desktop is: a task with the account's interactive
     * token, through the Task Scheduler's COM interface (the ScheduledTasks cmdlets use WMI, which is for
     * administrators only over WinRM). The script goes to a file in the account's temporary folder (base64, so it
     * needs no quoting), which it removes as it starts: as -EncodedCommand, encoded once more for WinRM, a script of
     * a couple of kilobytes would exceed Windows' command-line limit.
     */
    const inSession = (name: string, script: string) => guest(`
$file = Join-Path $env:TEMP 'trd-task-${name}.ps1'
[IO.File]::WriteAllText($file, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(`Remove-Item -LiteralPath $PSCommandPath -ErrorAction SilentlyContinue\n${script}`, 'utf8').toString('base64')}')), [Text.Encoding]::UTF8)
$s = New-Object -ComObject Schedule.Service; $s.Connect()
$d = $s.NewTask(0)
$d.Principal.LogonType = 3
$a = $d.Actions.Create(0)
$a.Path = 'powershell.exe'
$a.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $file + '"'
$s.GetFolder('\\').RegisterTaskDefinition('${name}', $d, 6, $null, $null, 3) | Out-Null
$s.GetFolder('\\').GetTask('${name}').Run($null) | Out-Null`)
    const dropTask = (name: string) => guest(`$s = New-Object -ComObject Schedule.Service; $s.Connect(); try { $s.GetFolder('\\').DeleteTask('${name}', 0) } catch { }`)
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
