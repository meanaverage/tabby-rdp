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
    return { guest, inSession, dropTask }
}
