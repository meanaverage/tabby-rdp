# Troubleshooting

For connection logs, open **Settings › Remote Desktop › Desktops › Open desktops**, then choose **Copy log**. In version 0.5.1, the list is in **Troubleshooting**. Review logs before sharing them.

<a id="certificate"></a>

## A certificate this computer can't verify, or one that has changed

A desktop you connect to directly (a remote desktop profile, an imported file) and an RD Gateway connect without asking when their certificate is valid for their name by this computer's certificate authorities, as an organisation's own desktops and gateways often are. Any other is shown the first time, with why it can't be verified (most often: it is the server's own, self-signed) and its fingerprint, before anything of your sign-in is sent: check the fingerprint with whoever runs it, some other way than this connection (it is also in the desktop's connection log), then choose **Trust the certificate**. The question also says whom the certificate says it was issued to and by, and when it is valid: its own word, which nothing has checked, unless its chain leads to an authority this computer trusts (another machine's certificate then shows that machine's name) and the TLS library didn't refuse it for a reason of its own (a limit set on the authority, say). An issuer you wouldn't expect there (one that inspects your network's connections, say) is worth asking about before you trust it, but the one you would expect proves nothing: anyone can make a certificate that names it. Only the fingerprint, checked some other way, does. A desktop behind an SSH host remembers its certificate on first use without asking, since the way there runs inside SSH. When a remembered certificate differs later, the plugin stops before signing in, so nothing of your sign-in has gone to that server; only a certificate an authority vouched for is replaced without a question, by another it vouches for too. Reinstalling the machine or renewing its certificate changes it: then choose **Trust the new certificate**. If neither happened, something else is answering at that address. A GNOME desktop only ever accepts the certificate the plugin made for it; a different one there means another program listens on its port. Remembered certificates are in Settings › Remote Desktop › Desktops.

<a id="sign-in"></a>

## Wrong user name or password

Windows and xrdp desktops sign in with an account on that machine (`DOMAIN\user` works). A saved password that no longer works is asked for again; **Sign in again…** in the tab's menu replaces it on purpose. xrdp doesn't refuse a wrong password: it shows its own login window instead. GNOME desktops never ask: the plugin manages their sign-in.

<a id="no-desktop"></a>

## No desktop found on a Linux host

The plugin uses GNOME Remote Desktop 46 or newer (Ubuntu 24.04, for example), with no root and no login screen. For KDE, XFCE, MATE and others, install xrdp and a desktop for its sessions: on Debian and Ubuntu, `sudo apt install xrdp xfce4`. A GNOME session already shared from the machine's own screen (GNOME's Desktop Sharing) has to be turned off first.

<a id="unreachable"></a>

## Can't reach a Windows desktop

Windows needs Remote Desktop turned on (Settings › System › Remote Desktop; Pro, Enterprise or Server). Behind an SSH host, the address is as that host sees it: from there, `nc -z <address> 3389` should succeed. For a VM or machine that may be off, give the desktop a VM name or MAC address in its edit form and it is started when opened.

<a id="reconnecting"></a>

## It keeps reconnecting

After sleep or a network change the desktop reconnects by itself, with growing pauses, and waits while the SSH connection is down (**Reconnect SSH** hurries that along). It stops after a few tries or on **Stop**. If it drops again right after connecting, check the host's free memory and that the desktop's session is still running there.

<a id="picture"></a>

## The picture is blurry or slow

**Sharpness › Retina** renders at your screen's device pixels, with the remote's scale set to match. Video (H.264) is used when the remote sends it: Windows does, GNOME only with a hardware encoder (VA-API or NVENC). **Show connection status** shows the frame rate, the round trip and how the picture comes.

<a id="sound"></a>

## No sound, or the microphone isn't heard

Sound and microphone changes apply on the next connection. xrdp needs `pipewire-module-xrdp` or `pulseaudio-module-xrdp`. The microphone needs the system's permission here (macOS: System Settings › Privacy & Security › Microphone, then restart Tabby). On GNOME, apps record from "Remoteaudio Source"; on Windows, the machine must allow audio recording redirection. A desktop whose microphone was stopped (**Stop** in the microphone's menu in Tabby's header, or **Send the microphone** unchecked in the desktop's menu) gets none, its reconnects included, until **Send the microphone** is checked again in its menu or that Tabby window is closed.

<a id="nested-ssh"></a>

## I typed ssh to another machine in a terminal

In an SSH tab (or a split pane) where you typed `ssh` on to another machine, **Desktop** opens that machine's desktop, going through the first one, and `desk` works there too. Desktop asks which desktop you mean, since which `ssh` runs there is the first machine's to say; pick the other machine's "from now on" to have it open at once the next times. Desktops you set up behind a host open in a tab connected to that host, not through another one. The first machine has to log in to the other by itself for this: with a key there, or agent forwarding, as `ssh -o BatchMode=yes` would. Tabby's **Reconnect** belongs to the tab: it reconnects the first machine and ends the ssh typed in it. To have both desktops side by side, open the first machine's desktop in one pane, and ssh on in the other.

<a id="extra-monitor"></a>

## The desktop is open somewhere else

GNOME Remote Desktop's headless mode gives each connection a screen of its own: a second computer, or another Tabby window, connected to the same account gets an empty extra screen rather than the same one. So when the desktop is open somewhere else already, you choose. **Take it over** disconnects the other connection, as Windows does; the session and its apps carry on, on this screen. **Open a second screen** keeps both, each with a screen of its own. A desktop taken over from here doesn't take itself back: it says so, and offers the same two choices.

<a id="recovery"></a>

## Recover a version, disable the plugin, or remove it

In **0.5.2 or newer**, open **Settings › Remote Desktop › Updates**. **Stable** is the default; **Preview** includes beta releases and release candidates when available. Choose an exact published version and confirm installation. **Return to stable** can install an older version. **Restore previous version** uses the version saved after the last successful installation from this page. On older releases, manage the package in **Tabby › Settings › Plugins**.

The confirmation dialog stays open through progress and the verified result. If installation fails, the dialog shows the cause. After success, close remote desktops and restart Tabby; Updates shows the running version and the installed version waiting for restart until then.

After running **0.5.3-rc.1**, use **0.5.3-rc.1 or newer**, including after uninstalling and reinstalling. This version
can save a separate gateway sign-in prompt (`@ask`) in desktops, profiles and defaults, including when a saved gateway
account is removed. Versions **0.5.1 and 0.5.2** can silently use the desktop's credentials for that gateway instead.
Updates records this minimum on startup even if update checks are paused, and retains the highest recorded minimum.
The safeguard applies to this computer's Updates page; manual npm installation, Tabby's plugin controls and older
installations on other computers can bypass it. Use the same minimum wherever this configuration is copied or synced.

If the plugin cannot load:

1. Open **Tabby › Settings › Plugins**. Disable **tabby-rdp** to stop it loading, or uninstall and reinstall it there. Restart Tabby after changing plugins. Tabby’s [configuration locations](https://github.com/Eugeny/tabby/wiki/Config-file) help locate your profile when the application cannot open.
2. For a specific known compatible version, open a terminal in **Tabby's plugin folder** (the folder containing the plugin installation's `package.json`, with `node_modules/tabby-rdp` below it). Run `npm install tabby-rdp@0.5.3-rc.1`, replacing `0.5.3-rc.1` with your known compatible exact version at or above the minimum above. Do not run this in the tabby-rdp source checkout, the application bundle, or inside `node_modules/tabby-rdp` itself. Fully quit and reopen Tabby afterwards.
3. If a later version has migrated saved data, respect that version's documented minimum. Reinstall a compatible stable version or the last working preview; do not force an older version across a migration boundary.

Disabling or uninstalling keeps desktops, profiles, settings, remembered certificates and saved credentials. It also leaves any remote helpers and remote applications in place. To remove saved entries, use **Remote Desktop › Desktops** and **Accounts**, and **Profiles & connections** for profiles, before uninstalling. Unlock the credential store first if required; check any reported failure rather than assuming a credential was deleted. Data synced to other computers may need attention there too.

For the optional `desk` remote helper, turn **Settings › Remote Desktop › Settings › desk: bring the console along** off and reconnect to each host while the plugin is still installed. The next connection removes the helper's own files and login hook; an offline host cannot be cleaned this way until it returns. Read the [desk cleanup details](docs/desk.md) for manual removal and read-only startup files. End remote applications you no longer need separately. Uninstalling this plugin does not shut down remote hosts or erase their files.
