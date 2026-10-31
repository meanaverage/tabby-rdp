[← README](../README.md)

# Settings and version management

## Versions and recovery

Open **Settings › Remote Desktop › Updates** to manage the installed version:

- **Stable** is the default. **Preview** also offers beta releases and release candidates when available.
- Automatic checks look for updates once a day. **Check now** checks manually; installation is always your choice.
- Choose an exact compatible version, **Return to stable**, or **Restore previous version** after an installation
  from this page. After running **0.5.3**, version changes require **0.5.3 or newer** to preserve separate
  gateway sign-in prompts; returning to an older stable release is blocked.
- **Uninstall plugin…** removes the package. **Manage in Tabby…** opens Tabby's plugin controls to disable it.
  Saved connections, settings, passwords and remote setup are kept.

The confirmation dialog stays open during installation or removal and shows progress, elapsed time and the verified
result. After success, close remote desktops and restart Tabby. Until then, Updates shows the running version and
the installed version waiting for restart. Preferences and version history stay on this computer.

See [troubleshooting and recovery](../TROUBLESHOOTING.md#recovery) if the plugin cannot load or you want to clean up saved
data or remote helpers.

## Settings

Open **Settings › Remote Desktop** in Tabby, right-click the desktop button in Tabby's header, or open **Settings** in the Remote Desktop section of a terminal's or tab's menu.
Desktop settings are stored in Tabby's config under `remoteDesktop`; update preferences and installation history
are local to this computer:

The Settings tab groups everyday controls first, followed by SSH integration, FreeRDP compatibility, and diagnostics.

### Connection

| Setting | Default | Behavior |
|---|---|---|
| RDP client (`client`) | IronRDP (`ironrdp`) | Experimental FreeRDP (`freerdp`) needs a matching native helper. Profiles and desktops can override the default; changes apply on reconnect. A global FreeRDP default falls back to IronRDP locally when its helper is absent; an explicit override reports the missing build. [Capabilities](../native/README.md). |

### Display

| Setting | Default | Behavior |
|---|---|---|
| When the pane is resized (`resize`) | Resize the remote desktop to fit (`live`) | Or reconnect at the new size (`reconnect`), or keep the resolution (`off`). |
| Keep the resolution: scale to fit or actual size (`zoom`) | Scale to fit (`fit`) | With `resize: off`: `actual` shows one remote pixel per point, with scroll bars when the desktop is larger than the pane (a Retina-sized desktop shows at twice the size). |
| Sharpness (`sharpness`) | Standard (`standard`) | Retina (`retina`): device pixels, with the remote's scale set to match. |
| For *this desktop* only (`desktopSharpness`) | As above | In the menu of a tab with a desktop open: Standard or Retina for that desktop, whatever the default. Kept by desktop (`user@host`, `user@host#address` for one behind a host, or `rdp#address` for a remote desktop profile's own tab). |
| Video decoding (`h264`) | On | H.264 decoded by Tabby's browser engine (hardware-accelerated where available), for what the remote sends as video; applies on the next connection. |
| Auto-hide header (`headerAutoHide`) | Never (`never`) | Under Display. `automatic`: only a connected remote desktop alone in the active tab; any split, even with a maximized pane, keeps the header visible. `always`: auto-hide across all tabs. Also available from **View › Hide Header** where Tabby has a native View menu. Existing hidden/removed Windows and Linux menu bars stay that way. |
| Minimum window size (`headerMinWidth`, `headerMinHeight`) | None (`0`, `0`) | Optional limits for Automatic, in logical pixels. Each nonblank dimension must meet its limit. Uses the actual window size, including manually resized windows. Never and Always ignore the limits. |
| Show connection status (`connectionStatus`) | Off | The indicator in the desktop's corner; fades when the pointer comes near. |

### Keyboard

| Setting | Default | Behavior |
|---|---|---|
| Send text as typed (`unicodeKeys`) | Off | Sends the characters the keyboard produces rather than key positions, so dead keys and a layout the remote doesn't have come out right; keys with Ctrl, Alt or ⌘ still go by position. Windows types any character; GNOME only those its own layout has (mutter has no keycode for the others). Input methods (CJK) are not supported yet. |
| Mac shortcuts (`macShortcuts`) | On | macOS. Off: ⌘ is the Windows key. |
| Shortcuts (`hotkeys.remote-desktop-*`) | ⌘⇧G / Ctrl+Shift+G for the switch; the rest unbound | Tabby's hotkeys: the switch between desktop and console, view only, screenshot, Ctrl+Alt+Del, type into all, paste to all, connection status, disconnect. Changed on the settings page (Getting started › Shortcuts) or in Settings › Hotkeys. |

### Sound

| Setting | Default | Behavior |
|---|---|---|
| Sound (`sound`) | On | Applies on the next connection. |
| Microphone (`microphone`) | Off | Send your microphone to a remote desktop that asks for it, as one does while an app there records. Turning it on applies on the next connection; turning it off stops it at once, also on a desktop still connecting. A desktop's menu can stop it for that desktop alone, until it is turned back on there or that Tabby window is closed. |

### Clipboard and shared folders

| Setting | Default | Behavior |
|---|---|---|
| Clipboard sharing (`clipboard`) | Both ways (`both`) | Or only from the remote desktop to this computer (`fromRemote`), or off (`off`), for text, pictures and files alike (FreeRDP shares text only); a desktop's own (`clipboard` in its profile or its `desktops` entry) takes its place ([Clipboard](sharing.md#clipboard)). Applies in full on the next connection; narrowing it also stops the sending at once to open desktops that follow it. |
| Shared folders (`sharedFolders`) | None | `[{ path, name, readOnly }]`: folders shared as drives with every remote desktop ([Shared folders](sharing.md#shared-folders)). Applies on the next connection. |

### SSH hosts

| Setting | Default | Behavior |
|---|---|---|
| Bring the console along with `desk` (`desk`) | Off | Installs `desk` and a login line on each machine you open a desktop on; applies on the next connection there. The key each machine's `desk` sends is kept as a fingerprint (`deskKeys`), from a machine whose desktop was opened with this on, and forgotten when it is opened with this off. |
| Session backend (`sessionBackend`) | `native` | For `desk`: `native` (trd-pty) or `tmux`. Config file only. |
| Find virtual machines on SSH hosts (`discoverVMs`) | On | Lists a host's libvirt VMs with a desktop in its menu ([VMs on a host](connections.md#vms-on-a-host)). |
| Shut down VMs it started (`shutDownIdle`) | Never | 5, 15 or 60: minutes without a desktop open after which a VM the plugin started is shut down again ([VMs on a host](connections.md#vms-on-a-host)). |

### FreeRDP compatibility

| Setting | Default | Behavior |
|---|---|---|
| Glyph caching (`glyphCache`) | Off (`false`) | FreeRDP only. Experimental compatibility for older RDP servers or PAM login screens with missing text; may cause display artifacts. Enable only for connections that need it. Profiles and desktop entries can override it with `true` or `false`; a profile’s `null` follows Settings through group defaults. Applies on reconnect. Glyph caching and relaxed order checks are independent. |
| Bitmap caching (`bitmapCache`) | Off (`false`) | FreeRDP only. Experimental compatibility for servers or PAM login screens that draw pictures, such as a logo, from cached bitmaps; without it those areas can stay blank. May cause display artifacts. Enable only for connections that need it. Profiles and desktop entries can override it with `true` or `false`; a profile’s `null` follows Settings through group defaults. Applies on reconnect. Independent of glyph caching and relaxed order checks. |
| Relax drawing order checks (`relaxOrderChecks`) | Off (`false`) | FreeRDP only. Allows a server or PAM proxy to send drawing orders it did not announce. Try it for a black screen or an unannounced-order error; it may help with some proxies, but does not address every black screen. RDP profiles and desktop entries can override the setting with `true` or `false`; a profile's `null` explicitly follows Settings through group defaults. Applies on reconnect. |

### Diagnostics

| Setting | Default | Behavior |
|---|---|---|
| Write a log file (`diagnosticLog`) | Off | `debug` or `trace`: each desktop opened from then on writes its connection log, with IronRDP's log at that level, to a file of its own in the log folder (`tabby-rdp-logs` next to Tabby's config), readable by you alone, for a bug report. Keys, passwords, licenses, tokens and other byte strings are left out of the file. [Questions and problems](../README.md#questions-and-problems) |

### Other Remote Desktop tabs

| Setting | Default | Behavior |
|---|---|---|
| Saved accounts (`accounts`) | None | `[{ id, name, username, domain }]`; see [Saved accounts](credentials-and-trust.md#saved-accounts). The passwords are in the Vault (encrypted, part of the config) or the keychain, never in plaintext in the config. |
| Check for updates automatically (Updates tab) | On, Stable | Checks npm once a day; choose Stable or Preview, check manually, and install a compatible version explicitly. [Versions and recovery](#versions-and-recovery). |
| Desktop name overlay (`osd`) | When it helps | `show` (`auto`, `always`, `off`), `font`, `size`, `position`, `color` (empty: white; else a color name, `#hex`, or a color function of numbers such as `rgb()`) and `seconds`; the settings page previews it, at a resolution you pick. |

Auto-hide frees the title/tab strip's space outside full screen. Move the pointer to the top edge to reveal the
header over the content; revealing it does not resize the remote desktop. The View menu and dropdown share the same
saved preference. Full screen continues to use Tabby's existing behavior. Native OS window decorations, when used,
remain governed by Tabby's frame setting. On Windows, the native minimize, maximize and close buttons remain
visible: hiding those requires support from Tabby itself. Hover reveal works in both restored and maximized windows,
including the Windows resize border. The microphone indicator stays available while the header is hidden.
