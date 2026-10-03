<#
.SYNOPSIS
Makes a Windows Server test machine a Hyper-V host with a guest VM, and an RD Gateway, for tabby-rdp's tests of
both ways to a desktop. Run after ..\windows\setup.ps1 (Remote Desktop, WinRM, the test account).

.DESCRIPTION
Two stages, since the roles need a restart:

- roles: installs Hyper-V and RD Gateway, leaves a task that runs the second stage at startup, and restarts.
- configure (at startup, as SYSTEM): the gateway's certificate and its policies (the test account may connect
  through it to any computer); Hyper-V's enhanced session mode; two guest VMs; the test account as a Hyper-V
  administrator, which is what lets it connect to a guest's console; OpenSSH Server. It ends by writing
  C:\tabby-rdp\ready.txt.

The guests: "tabby-rdp-empty" has no disk and sits at its firmware's screen, which is console enough to connect to;
it always runs. "tabby-rdp-guest" is Windows (Server Core), made from the image on the installation disc (which has
to be still in the drive), with the test account in it, for enhanced sessions. The test account may open both
consoles; listing the VMs (Get-VM, over SSH) took an administrator, tabbyadmin, when this was tried. With
-NoGuestStart the Windows guest is made but left off: where the machine is a VM on a host that is a VM itself, a guest that starts an operating system froze the
whole machine within a minute (a guest in its firmware didn't).

Hyper-V needs virtualization in the machine itself: in a VM, nested virtualization (a libvirt VM with
host-passthrough CPU on a host whose KVM has `nested` on).

What it does is logged to C:\tabby-rdp\server.log.

.PARAMETER Stage
roles (the default) or configure.

.PARAMETER UserName
The test account (default: tabbyrdp), created by setup.ps1.

.PARAMETER Password
Its password, for the same account in the guest VM. Needed for the roles stage.

.PARAMETER NoGuestStart
Leaves the Windows guest off (see above).
#>
[CmdletBinding()]
param(
    [ValidateSet('roles', 'configure')] [string] $Stage = 'roles',
    [string] $UserName = 'tabbyrdp',
    [string] $Password,
    [switch] $NoGuestStart
)
$ErrorActionPreference = 'Stop'
$home_ = 'C:\tabby-rdp'
$guest = 'tabby-rdp-guest'
$empty = 'tabby-rdp-empty'
New-Item -ItemType Directory -Force -Path $home_ | Out-Null
# Administrators only: the second stage runs this folder's copy of the script as SYSTEM.
icacls $home_ /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

# A log of its own rather than a transcript: a transcript starts with the command line, the password in it.
function Log ([Parameter(ValueFromPipeline)] $line) {
    process {
        $text = "$(Get-Date -Format 'HH:mm:ss') $line"
        Add-Content -Path "$home_\server.log" -Value $text
        Write-Host $text
    }
}
function Step ([string] $what, [scriptblock] $do) {
    Log "== $what"
    try { & $do } catch { Log "FAILED: ${what}: $_"; throw }
}

if ($Stage -eq 'roles') {
    if (-not $Password) { throw 'Pass -Password: the test account''s password, for the same account in the guest VM.' }
    Copy-Item -Force $PSCommandPath "$home_\server.ps1"
    Set-ItemProperty "$home_\server.ps1" -Name IsReadOnly -Value $false  # as copied from a disc
    # The guest's account gets the same password: kept for the second stage (the folder is the administrators').
    Set-Content -Path "$home_\guest.txt" -Value $Password -NoNewline

    Step 'RD Gateway' { Install-WindowsFeature RDS-Gateway -IncludeManagementTools | Out-Null }
    Step 'Hyper-V' {
        try {
            Install-WindowsFeature Hyper-V -IncludeManagementTools | Out-Null
        } catch {
            # In a VM, the feature's own check can refuse ("a hypervisor is already running") although nested
            # virtualization is there. DISM doesn't check.
            Log "Install-WindowsFeature: $_; enabling the feature with DISM"
            dism /online /enable-feature /featurename:Microsoft-Hyper-V /all /norestart | Log
            Install-WindowsFeature RSAT-Hyper-V-Tools | Out-Null
        }
    }
    Step 'the second stage, at startup' {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$home_\server.ps1`" -Stage configure -UserName $UserName$(if ($NoGuestStart) { ' -NoGuestStart' })"
        Register-ScheduledTask -TaskName 'tabby-rdp-server' -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) `
            -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    }
    Log 'restarting'
    Restart-Computer -Force
    return
}

# ---- configure ------------------------------------------------------------------------------------

Step 'OpenSSH Server' {
    # Part of Windows Server 2025; a capability to add before it.
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
        Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
    }
    Set-Service sshd -StartupType Automatic
    Start-Service sshd
    if (-not (Get-NetFirewallRule -Name 'tabby-rdp-ssh' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'tabby-rdp-ssh' -DisplayName 'tabby-rdp: OpenSSH Server' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
    }
    # PowerShell as the shell SSH logins get: what the plugin asks a Hyper-V host its VMs with.
    New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
    Set-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    # Windows Server 2025's sshd_config lets in administrators and this group only.
    $ssh = Get-LocalGroup -Name 'OpenSSH Users' -ErrorAction SilentlyContinue
    if ($ssh -and -not (Get-LocalGroupMember -Group $ssh | Where-Object { $_.Name -like "*\$UserName" })) {
        Add-LocalGroupMember -Group $ssh -Member $UserName
    }
}

Step 'RD Gateway: certificate and policies' {
    Import-Module RemoteDesktopServices
    $thumbprint = (Get-Item RDS:\GatewayServer\SSLCertificate\Thumbprint).CurrentValue
    if (-not $thumbprint -or -not (Test-Path "Cert:\LocalMachine\My\$thumbprint")) {
        $names = @($env:COMPUTERNAME) + @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object IPAddress)
        $cert = New-SelfSignedCertificate -DnsName $names -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddYears(5)
        Set-Item RDS:\GatewayServer\SSLCertificate\Thumbprint -Value $cert.Thumbprint
    }
    # Who may connect (a password is enough), and to what (anything the gateway reaches).
    $users = 'Remote Desktop Users@BUILTIN'
    if (-not (Test-Path RDS:\GatewayServer\CAP\tabby-rdp)) {
        New-Item -Path RDS:\GatewayServer\CAP -Name 'tabby-rdp' -UserGroups $users -AuthMethod 1 | Out-Null
    }
    if (-not (Test-Path RDS:\GatewayServer\RAP\tabby-rdp)) {
        New-Item -Path RDS:\GatewayServer\RAP -Name 'tabby-rdp' -UserGroups $users -ComputerGroupType 2 | Out-Null
    }
    Restart-Service TSGateway
}

Step 'Hyper-V: enhanced sessions, and the test account may connect to VMs' {
    for ($i = 0; $i -lt 60 -and (Get-Service vmms).Status -ne 'Running'; $i++) { Start-Sleep 5 }
    Set-VMHost -EnableEnhancedSessionMode $true
    $admins = Get-LocalGroup -SID 'S-1-5-32-578'  # Hyper-V Administrators
    if (-not (Get-LocalGroupMember -Group $admins | Where-Object { $_.Name -like "*\$UserName" })) {
        Add-LocalGroupMember -Group $admins -Member $UserName
    }
    # VMConnect's port. The role's own rule for it has a localized name; one of ours is simpler to find.
    if (-not (Get-NetFirewallRule -Name 'tabby-rdp-vmconnect' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'tabby-rdp-vmconnect' -DisplayName 'tabby-rdp: Hyper-V VM consoles' -Direction Inbound -Protocol TCP -LocalPort 2179 -Action Allow | Out-Null
    }
}

Step "the guest VM, $guest" {
    if (Get-VM -Name $guest -ErrorAction SilentlyContinue) { return }
    $wim = Get-Volume | Where-Object DriveLetter | ForEach-Object { "$($_.DriveLetter):\sources\install.wim" } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $wim) { throw 'No Windows installation disc in a drive (sources\install.wim): the guest is made from its image.' }
    $password = Get-Content "$home_\guest.txt" -Raw
    $vhd = "$home_\$guest.vhdx"
    Remove-Item $vhd -ErrorAction SilentlyContinue
    New-VHD -Path $vhd -SizeBytes 40GB -Dynamic | Out-Null
    # An EFI system partition and Windows, with letters for as long as the image is applied.
    $script = "$home_\guest-disk.txt"
    Set-Content $script @"
select vdisk file="$vhd"
attach vdisk
convert gpt
create partition efi size=260
format fs=fat32 quick label=System
assign letter=S
create partition msr size=16
create partition primary
format fs=ntfs quick label=Windows
assign letter=V
"@
    diskpart /s $script | Log
    try {
        # Image 1: Standard, Server Core. A console window is desktop enough for a session, and it starts fast.
        Expand-WindowsImage -ImagePath $wim -Index 1 -ApplyPath 'V:\' | Out-Null
        bcdboot V:\Windows /s S: /f UEFI | Log
        # The guest's own first start: its name, the administrator's password, the test account.
        $escaped = [Security.SecurityElement]::Escape($password)
        New-Item -ItemType Directory -Force -Path V:\Windows\Panther | Out-Null
        Set-Content -Path V:\Windows\Panther\unattend.xml -Encoding UTF8 -Value @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>tabby-rdp-guest</ComputerName>
      <TimeZone>UTC</TimeZone>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE><HideEULAPage>true</HideEULAPage><ProtectYourPC>3</ProtectYourPC></OOBE>
      <UserAccounts>
        <AdministratorPassword><Value>$escaped</Value><PlainText>true</PlainText></AdministratorPassword>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>$UserName</Name>
            <Group>Users;Remote Desktop Users</Group>
            <Password><Value>$escaped</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
    </component>
  </settings>
</unattend>
"@
    } finally {
        Set-Content $script "select vdisk file=`"$vhd`"`r`ndetach vdisk"
        diskpart /s $script | Log
        Remove-Item $script
    }
    New-VM -Name $guest -Generation 2 -MemoryStartupBytes 2GB -VHDPath $vhd | Out-Null
    # One processor: what a host with one has room for (see libvirt.sh on why a nested host has one).
    Set-VM -Name $guest -ProcessorCount 1 -AutomaticStopAction ShutDown -CheckpointType Disabled `
        -AutomaticStartAction $(if ($NoGuestStart) { 'Nothing' } else { 'Start' })
    Remove-Item "$home_\guest.txt"
    if ($NoGuestStart) {
        Log 'left off (-NoGuestStart)'
    } else {
        # A slow host can time out starting the VM's worker process; it starts with the host from then on.
        try { Start-VM -Name $guest } catch { Log "the guest didn't start this time ($_); it starts when the host does" }
    }
}

Step "the empty guest VM, $empty" {
    if (-not (Get-VM -Name $empty -ErrorAction SilentlyContinue)) {
        New-VM -Name $empty -Generation 2 -MemoryStartupBytes 512MB -NoVHD | Out-Null
        Set-VM -Name $empty -ProcessorCount 1 -AutomaticStartAction Start -AutomaticStopAction TurnOff -CheckpointType Disabled
    }
    if ((Get-VM -Name $empty).State -ne 'Running') {
        try { Start-VM -Name $empty } catch { Log "it didn't start this time ($_); it starts when the host does" }
    }
}

Step 'the test account may open the guests'' consoles' {
    # Hyper-V Administrators (above) covers it; this is the grant made for accounts that aren't administrators.
    foreach ($name in $guest, $empty) {
        if (-not (Get-VMConnectAccess -VMName $name | Where-Object { $_.Username -like "*\$UserName" })) {
            Grant-VMConnectAccess -VMName $name -UserName $UserName
        }
    }
}

Step 'done' {
    Unregister-ScheduledTask -TaskName 'tabby-rdp-server' -Confirm:$false -ErrorAction SilentlyContinue
    $vms = (Get-VM -Name $guest, $empty | ForEach-Object { "$($_.Name) $($_.Id) ($($_.State))" }) -join ', '
    Set-Content "$home_\ready.txt" "RD Gateway on 443; Hyper-V VM consoles on 2179; guests: $vms"
    Log (Get-Content "$home_\ready.txt")
}
