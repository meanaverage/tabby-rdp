<#
.SYNOPSIS
Prepares a Windows 10/11 Pro (or Server) machine, preferably a VM, as a tabby-rdp test machine.

.DESCRIPTION
- Turns on Remote Desktop (with Network Level Authentication) and its firewall rules.
- Turns on WinRM over HTTP (NTLM with message encryption), which the Windows suite uses to check what happened
  inside Windows: typing, clipboard, sound and files.
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

# WinRM over HTTP. NTLM with message encryption (what the suite uses) needs no HTTPS listener.
Enable-PSRemoting -SkipNetworkProfileCheck -Force | Out-Null

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
