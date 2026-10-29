[← README](../README.md)

# IronRDP and upstream contributions

The desktop is [IronRDP](https://github.com/Devolutions/IronRDP)'s web client: an RDP implementation in Rust, compiled
to WebAssembly, with a web component. It connects to Windows, but a browser-based client for GNOME Remote Desktop
needed more: GNOME only speaks RDP's graphics pipeline, which IronRDP's web client didn't offer; it resizes its
monitor in a way the web client didn't follow; and it depends on details of the sound and dynamic-channel protocols
that IronRDP got slightly wrong. The web client also had no sound at all.

tabby-rdp ships IronRDP with a short series of patches ([ironrdp/](../ironrdp)). Before each release, CI rebuilds it
from IronRDP's source and the patches, and the release goes out only if the two builds are identical, byte for byte
([how](../ironrdp/README.md#reproducing-vendor)). The fixes go upstream, one by one:

| Change | Upstream |
|---|---|
| Keep the session when a server sends data on a channel the client declined | [Devolutions/IronRDP#2005](https://github.com/Devolutions/IronRDP/pull/2005) |
| Fit the web component to its container, not the whole window | [Devolutions/IronRDP#2006](https://github.com/Devolutions/IronRDP/pull/2006) |
| Set up the clipboard before signaling `ready`, so it works for apps that connect right away | [Devolutions/IronRDP#2018](https://github.com/Devolutions/IronRDP/pull/2018) |
| Echo the correct size in the sound channel's Training Confirm | [Devolutions/IronRDP#2019](https://github.com/Devolutions/IronRDP/pull/2019) |
| The graphics pipeline in the web client, following its resets | Covered by [Devolutions/IronRDP#1977](https://github.com/Devolutions/IronRDP/pull/1977) (not ours; [tested with GNOME](https://github.com/Devolutions/IronRDP/pull/1977#issuecomment-5851624036)) |
| Sound in the web client | [Devolutions/IronRDP#2020](https://github.com/Devolutions/IronRDP/pull/2020) |
| Let the host send key events to a session | [Devolutions/IronRDP#2026](https://github.com/Devolutions/IronRDP/pull/2026) (design under discussion) |
| Decode Windows' RemoteFX Progressive refinements | Covered by [Devolutions/IronRDP#2010](https://github.com/Devolutions/IronRDP/pull/2010) and [#1977](https://github.com/Devolutions/IronRDP/pull/1977) (not ours) |
| H.264 in the web client, decoded by the browser (WebCodecs) | Not submitted yet: waits for #1977 |
| Microphone in the web client | Not submitted yet: waits for #2020 |
| Keep clipboard sync working for the other desktops when one closes | Not submitted yet |
| Sync the clipboard only for the desktop that has the focus | Not submitted yet |
| Drive redirection in the web client, through a JavaScript file system | Not submitted yet |
| Send chunked static-channel messages without CHANNEL_FLAG_SHOW_PROTOCOL, as Windows' drive redirector expects | Not submitted yet |
| Keep the bitmap cache across ResetGraphics (a live resize repaints from it) | [Devolutions/IronRDP#2011](https://github.com/Devolutions/IronRDP/pull/2011), merged; taken as a patch until the next base |
| Keep Progressive tile state per surface across codec contexts | [Devolutions/IronRDP#2117](https://github.com/Devolutions/IronRDP/pull/2117), open; taken as a patch |

The aim is to make IronRDP's browser client work well with both Linux and Windows desktops, for everyone who embeds
it, not just this plugin.
