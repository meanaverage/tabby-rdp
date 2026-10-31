[← README](../README.md)

# IronRDP and upstream contributions

The desktop is [IronRDP](https://github.com/Devolutions/IronRDP)'s web client: an RDP implementation in Rust, compiled
to WebAssembly, with a web component. It connects to Windows, but a browser-based client for GNOME Remote Desktop
needed more: GNOME only speaks RDP's graphics pipeline, which IronRDP's web client didn't offer; it resizes its
monitor in a way the web client didn't follow; and it depends on details of the sound and dynamic-channel protocols
that IronRDP got slightly wrong. The web client also had no sound at all.

tabby-rdp ships IronRDP's latest release with a short series of patches ([ironrdp/](../ironrdp)). Before each
release, CI rebuilds it from IronRDP's source and the patches, and the release goes out only if the two builds are
identical, byte for byte ([how](../ironrdp/README.md#reproducing-vendor)). The fixes go upstream, one by one, and once
IronRDP has a change, released, the patch for it goes:

| Change | Upstream |
|---|---|
| Keep the session when a server sends data on a channel the client declined | [Devolutions/IronRDP#2341](https://github.com/Devolutions/IronRDP/pull/2341) (open). It replaced our first attempt, [#2005](https://github.com/Devolutions/IronRDP/pull/2005), which dropped data for any channel that wasn't open |
| Fit the web component to its container, not the whole window | [Devolutions/IronRDP#2006](https://github.com/Devolutions/IronRDP/pull/2006) (open) |
| Set up the clipboard before signaling `ready`, so it works for apps that connect right away | [Devolutions/IronRDP#2018](https://github.com/Devolutions/IronRDP/pull/2018), merged and released; no longer a patch |
| Echo the correct size in the sound channel's Training Confirm | Ours, [#2019](https://github.com/Devolutions/IronRDP/pull/2019), was closed for [#2294](https://github.com/Devolutions/IronRDP/pull/2294) (not ours), the same fix, merged; taken as #2294's commit until it is released |
| Answer the auto-detect requests Windows Server with RDS licensing sends while connecting | [Devolutions/IronRDP#2128](https://github.com/Devolutions/IronRDP/pull/2128), merged; taken as the merged commit until it is released |
| The graphics pipeline in the web client, following its resets | Covered by [Devolutions/IronRDP#1977](https://github.com/Devolutions/IronRDP/pull/1977) (not ours, open; [tested with GNOME](https://github.com/Devolutions/IronRDP/pull/1977#issuecomment-5851624036)) |
| Sound in the web client | [Devolutions/IronRDP#2020](https://github.com/Devolutions/IronRDP/pull/2020) (open) |
| Let the host send key events to a session | [Devolutions/IronRDP#2026](https://github.com/Devolutions/IronRDP/pull/2026) (open; design under discussion) |
| Decode Windows' RemoteFX Progressive refinements | Fixed by [Devolutions/IronRDP#2134](https://github.com/Devolutions/IronRDP/pull/2134) (not ours), released; no longer a patch |
| H.264 in the web client, decoded by the browser (WebCodecs) | Not submitted yet: waits for #1977 |
| Microphone in the web client | Not submitted yet: waits for #2020 |
| Keep clipboard sync working for the other desktops when one closes | Not submitted yet |
| Sync the clipboard only for the desktop that has the focus | Not submitted yet |
| Drive redirection in the web client, through a JavaScript file system | Not submitted yet |
| Send chunked static-channel messages without CHANNEL_FLAG_SHOW_PROTOCOL, as Windows' drive redirector expects | Fixed by [Devolutions/IronRDP#2177](https://github.com/Devolutions/IronRDP/pull/2177) (not ours), released; no longer a patch |
| Keep the bitmap cache across ResetGraphics (a live resize repaints from it) | [Devolutions/IronRDP#2011](https://github.com/Devolutions/IronRDP/pull/2011) (not ours), released; no longer a patch |
| Keep Progressive tile state per surface across codec contexts | [Devolutions/IronRDP#2117](https://github.com/Devolutions/IronRDP/pull/2117) (not ours), released; no longer a patch |

The patches also bound what a server can make the client hold or compute; those that build on limits IronRDP added
since, and the issues filed upstream, are listed in [ironrdp/README.md](../ironrdp/README.md#upstream-contributions).

The aim is to make IronRDP's browser client work well with both Linux and Windows desktops, for everyone who embeds
it, not just this plugin.
