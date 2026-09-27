<#
.SYNOPSIS
Prepares a Windows 10/11 Pro (or Server) machine, preferably a VM, as a tabby-rdp test machine.

.DESCRIPTION
- Turns on Remote Desktop (with Network Level Authentication) and its firewall rules.
- Turns on WinRM over HTTP (NTLM with message encryption), which the Windows suite uses to check what happened
  inside Windows: typing, clipboard, sound and files.
  Marks the network private first (WinRM's settings can't be changed on a public one), and lets the test account
  use WinRM's command shell, which the suite's checks run in.
- Creates a local test account that can sign in over Remote Desktop and WinRM, without administrator rights.

Run in an elevated PowerShell:

    Set-ExecutionPolicy -Scope Process Bypass
    .\setup.ps1 -Password '<a password for the test account>'

.PARAMETER UserName
The test account (default: tabbyrdp).

.PARAMETER Password
Its password. Needed when the account doesn't exist yet.
#>
[CmdletBinding()]
param(
    [string] $UserName = 'tabbyrdp',
    [string] $Password
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this in an elevated PowerShell (Run as administrator).'
}

# Remote Desktop, with NLA. The firewall group is addressed by its resource id: its name is localized.
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -Value 1
Enable-NetFirewallRule -Group '@FirewallAPI.dll,-28752'

# WinRM's settings can't be changed while a network is Public (and it only answers the local subnet there): a test
# machine's network is a private one.
Get-NetConnectionProfile | Where-Object NetworkCategory -eq Public | Set-NetConnectionProfile -NetworkCategory Private

# WinRM over HTTP. NTLM with message encryption (what the suite uses) needs no HTTPS listener.
Enable-PSRemoting -SkipNetworkProfileCheck -Force | Out-Null
# Remote Management Users may use PowerShell remoting, but not WinRM's command shell, which the suite's checks run
# in (pywinrm): only administrators may by default. Let the group use it too.
$rootSddl = (Get-Item WSMan:\localhost\Service\RootSDDL).Value
if ($rootSddl -notmatch '\(A;;GA;;;RM\)') {
    Set-Item WSMan:\localhost\Service\RootSDDL -Value ($rootSddl -replace '^(O:[^:]+G:[^:]+D:P?)', '$1(A;;GA;;;RM)') -Force
}

# No news, weather or pictures on the taskbar and in its search box: the same desktop every time, in tests and pictures.
foreach ($policy in @(
        @{ Path = 'HKLM:\SOFTWARE\Policies\Microsoft\Dsh'; Name = 'AllowNewsAndInterests' },
        @{ Path = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search'; Name = 'EnableDynamicContentInWSB' })) {
    New-Item -Path $policy.Path -Force | Out-Null
    Set-ItemProperty -Path $policy.Path -Name $policy.Name -Value 0 -Type DWord
}

# The test account: Remote Desktop and WinRM, not an administrator.
$account = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
if (-not $account) {
    if (-not $Password) { throw "The account $UserName doesn't exist: pass -Password to create it." }
    New-LocalUser -Name $UserName -Password (ConvertTo-SecureString $Password -AsPlainText -Force) `
        -PasswordNeverExpires -AccountNeverExpires -Description 'tabby-rdp test account' | Out-Null
} elseif ($Password) {
    Set-LocalUser -Name $UserName -Password (ConvertTo-SecureString $Password -AsPlainText -Force)
}
foreach ($sid in 'S-1-5-32-555', 'S-1-5-32-580') {  # Remote Desktop Users, Remote Management Users
    $group = Get-LocalGroup -SID $sid
    if (-not (Get-LocalGroupMember -Group $group | Where-Object { $_.Name -like "*\$UserName" })) {
        Add-LocalGroupMember -Group $group -Member $UserName
    }
}

Write-Host "Ready: $env:COMPUTERNAME, account $UserName. Remote Desktop on 3389, WinRM on 5985."
Write-Host 'Sign in once over Remote Desktop (from the plugin or any client) so the account has a profile.'
