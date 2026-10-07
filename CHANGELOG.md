# Changelog

## 0.5.3-rc.1

Local release candidate; not published on npm or as a GitHub release.

**Added**
- **Each desktop connection has its own WebAssembly instance**, while sharing compiled IronRDP code. Reconnecting
  or recovering from an instance fault creates a fresh backend for that desktop without replacing other desktops.
- **Instance lifecycle checks** cover independent memories, cleanup, reconnects and collection after disposal,
  with a browser smoke test and a live two-desktop isolation suite.

**Fixed**
- **Ended connections release their backend and browser resources**, including timers, global listeners, media,
  and the statistics indicator's canvas hook, while retaining the last picture for the disconnected pane.
- **Profile Save validates the address and RD Gateway before committing either field.** Invalid edits keep the
  editor open and focus the field to correct, instead of saving an invalid gateway or silently keeping an old address.

**Changed**
- **Preview publishing uses npm's beta tag** for both beta and release-candidate versions. GitHub release drafts
  remain unpublished until the staged npm package is approved and verified.

Qualification and remaining stable-release checks are tracked in [#49](https://github.com/meanaverage/tabby-rdp/issues/49).

## 0.5.2

**Added**
- **Updates settings** include stable and preview channels (beta releases and release candidates), automatic and
  manual checks, compatible version selection, rollback and uninstall controls. Changes require confirmation and
  take effect after restarting Tabby. Update preferences and installation history stay on this computer.
- **Installation progress stays in the confirmation dialog**, with elapsed time and a verified success or failure
  result. The dialog remains visible if Settings closes. The installed version is checked before reporting success.

**Fixed**
- **Commands through the system SSH report SSH's own failure** when it exits before reading their input,
  instead of letting a broken-pipe error escape unhandled. Commands that ignore their input still return their output.
- **Plugin startup waits for Tabby's configuration** before migrating update preferences, avoiding an error that
  could disable third-party plugins for the session.

**Changed**
- **Troubleshooting opens the Markdown guide** from the links at the top of Remote Desktop settings. The former
  Troubleshooting tab is now Updates; connection logs are under Desktops. Empty lists use concise status messages.
- **Settings descriptions are shorter**, and help icons appear consistently after their descriptions.
- **Troubleshooting and desk cleanup guides are included in the npm package.**
- **Host compatibility checks share one layer**, with host and runtime versions, the host's declared xterm dependency,
  and observed capabilities included in copied connection logs. Modal drag fallbacks and terminal input handling use
  shared adapters that check the host's actual features, including on forks and nightly builds.
- **CI and the release workflow check out the code with actions/checkout 7.0.1** (#56), pinned to its commit as before,
  in place of 4.4.0. Nothing in the package changes.

## 0.5.1

Security fixes from an audit of 0.5.0: saved passwords and certificates, what a host says about its desktops, `desk`,
shared folders and file transfers, what a server, gateway or SSH host can make Tabby do, and what a connected desktop
can do. Clipboard sharing can be narrowed or turned off, and a release ships IronRDP only as its sources build it.

**Security**
- **An imported .rdp profile no longer signs in with a saved account on its own.** If you had set a default account
  for a profile group or for remote desktops in general, a profile made from an .rdp file used to adopt it and send
  its password to the address and gateway the file named, with no sign-in prompt. Once such a profile had been saved
  in Tabby's profile editor (which drops the values that equal the defaults then), it could also take a default
  gateway account set since, which went to the gateway the file named the same way, and a default kind of xrdp, which
  would have had the password go without Network Level Authentication, unasked. An imported profile now has no
  account, no gateway account and the Windows kind whatever the defaults say (`null` for each, which Tabby's profile
  editor keeps when it saves), so it asks for its sign-in, unless a password was saved already for that same address
  reached the same way (through the same gateway, or none; not one 0.5.0 saved there for a desktop reached through a
  gateway, which is forgotten: below); pick a saved account or a kind in its profile settings if you want one.
  Profiles imported before this update and not saved in the profile editor since are changed the same way, when Tabby
  starts and whenever its config changes (config sync included): they ask for their account once instead of taking a
  default one. And removing a saved account now leaves the profiles that used it asking for an account, as its
  confirmation says, rather than taking their group's default.
- **A certificate this computer can't verify is confirmed before anything of your sign-in goes to the server.** A
  remote desktop you connect to directly (an RDP profile, quick connect, an imported .rdp file, a restored tab)
  remembered the first certificate it met without asking, and so did an RD Gateway, so someone in the middle of that
  first connection, or a file naming a gateway of its own, could take the sign-in: a proof of your password that can be
  attacked offline. Now a certificate valid for the server's name by the certificate authorities this computer trusts
  (the public ones, and with a recent Tabby those of the system's own store too, such as an organisation's) connects
  without a question, and any other is shown the first time, before anything of your sign-in goes to the server (the
  connection request and the TLS handshake have): the address, why it can't be verified, its SHA-256 fingerprint and
  what it says of itself (whom it was issued to and by, and when it is valid, which the desktop's log has too), with
  Cancel as what Enter picks. Why it can't be verified is the plugin's own reading, since the TLS library reports only
  the last of its checks that failed, which whoever makes the certificate can choose. First, unless its chain leads to
  an authority this computer trusts, where that chain stands: self-signed (Windows' own RDP certificate included,
  whatever its key usage), from an authority this computer doesn't trust, or no way to one from what the server sent
  (only an authority counts as an issuer, so one signed with the key of a certificate issued to a server leads to
  none; and an authority is known by its name and key, as the TLS library knows it, so its root sent along
  cross-signed by another counts). Then, whatever the chain: issued for another name (checked by the plugin, since
  Node checks the name only once a chain checks out), expired or not valid yet (by its own dates), and marked for
  other uses than a server's. Only one for that name whose chain leads to an authority this computer trusts is said to
  be like some organisations' Remote Desktop certificates. What it says of itself is marked as its own word, which
  nothing has checked, unless an authority vouched for it or its chain leads to one this computer trusts (another
  machine's certificate then shows that machine's name), and the TLS library didn't refuse it for a reason of its own (a
  limit set on the authority, say): an issuer you would expect there proves nothing, since anyone can make a certificate
  that names it; only the fingerprint, checked some other way, does. For a server without Network Level Authentication
  it says that signing in sends the password itself, not a proof of it. A certificate
  whose only use is Remote Desktop Authentication (as Active Directory's Remote Desktop templates issue them) isn't
  valid for a server by these rules, whatever issued it, and is asked about too, at each renewal as well.
  Automatic reconnects stop at the question. A certificate you trust is remembered as yours, and a different one there
  later stops the connection whatever vouches for it; one an authority vouched for may be replaced by another it
  vouches for (a renewal), which connects and is noted in the desktop's log. The same one connects only while that word
  holds: once it has expired, or its authority is gone from this computer's store, it is asked about as at first, since
  you never confirmed it, and trusting it then makes it yours. Trusting a certificate never allows signing in without
  Network Level Authentication. Desktops behind an SSH host still remember their first certificate without asking: SSH
  vouches for the host they are reached through, though not for what answers behind it.
  Certificates remembered before this update stay remembered: a desktop's is held to that certificate as before
  (unless an authority vouches for it, when it counts as met for the first time now), and a gateway's may still be
  replaced by one an authority vouches for. The .rdp import dialog says plainly that a gateway is signed in to first.
- **A machine reached with `ssh` typed in an SSH tab is filed under that tab's host.** What the plugin keeps per
  desktop (a saved password, the remembered certificate, permission to sign in without Network Level Authentication)
  was found for such a machine by a name the host there reported, so a hostile host could pass a desktop of its own
  off as another one you had used, behind another host too, and have that desktop's saved password sent to it. Such a
  machine's desktop is now kept under the host it is reached through: a host can only ever name desktops of its own.
  Desktops reached this way ask for their sign-in once more and remember their certificate anew (a sharpness set for
  one is set again): what was saved for them can't be told apart from what a host could claim, so none of it is used.
  The same machine opened in a tab of its own now counts as another desktop: a tab with that one open isn't switched
  to. Desktops configured behind a host belong to tabs connected to that host, not to a machine reached through
  another one, whose name there is that host's word: only that machine's own desktop opens through it. And the names
  hosts are kept under are now written so that no two can be the same: a host whose user or host name has a `%`, `#`
  or `>` in it (an IPv6 address with its zone, `fe80::1%en0`) is kept under a new name, and what was kept for it moves
  along, its remembered certificates and sharpness at once and a saved password at its next sign-in; desk's key and
  the choices made "from now on" for it are asked about again. A host whose user name has a `#` gets its desktops'
  passwords asked for again instead, and those kept under its old name are forgotten once a tab to that host is open
  again: from the keychain the next time a saved password is looked up, saved or forgotten and it answers, and from
  Tabby's Vault (if it is on) the next such time the Vault is open. There they read as no desktop's, so removing or
  editing one of its desktops left them in place, kept for good. Where the old name could be another account's new
  one, nothing moves, and that host's desktops ask again: `alice%23ops@host` is how `alice#ops@host` is written now,
  and an old name with a numeric IPv6 zone whose first two digits are 10 to 19, 23, 25 or 40 (`%12`, say) reads as such
  a name too. What a hostile host may have planted under another desktop's name before this update can't be told
  apart, and stays: a certificate that isn't the server's still stops the connection.
- **Desktop asks when a console's `ssh` would lead it elsewhere.** Which `ssh` runs in an SSH tab's console is what
  the host there says, so a host could have **Desktop** open a machine of its choosing in place of its own, without a
  word. Desktop now asks which desktop to open: the tab's own (the first choice), or that machine's, this time or
  **from now on**. Only "from now on" opens that machine's desktop at once the next times `ssh` leads there from that
  host. An `ssh` to a name with characters that could hide part of it or show it in another order (control and format
  characters, and the others that don't show, as the .rdp import has them) isn't offered. A "from now on" is taken back
  in Tabby's config file (`remoteDesktop.nestedSSH`). A desktop picked in the tab's menus is always the tab's host's,
  also where a machine's own desktop is open in the pane, which the menus then offer to replace with the host's own
  (and `desk` opens the desktop of the machine it ran on), and a sign-in form for a machine reached through a host
  names that host.
- **A saved desktop password is no longer reused for a different gateway.** A remembered password was kept by the
  desktop's address alone, so a profile that named the same address through another gateway could send it there without
  asking. Saved passwords are now tied to the way they were entered for: through that gateway (in any spelling of it),
  whether it takes the desktop's sign-in or an account of its own, or through none. A desktop reached through a gateway
  asks for its password once after this update; the password 0.5.0 saved for it, under the address alone, which a
  desktop at that address without a gateway (a quick connect, another profile, an .rdp file naming it) would now find
  and use unasked, is forgotten after the update, for each desktop configured to go through a gateway by then, so that
  desktop asks once too: once in each computer's keychain and once in Tabby's Vault, the first time a password is looked
  up, saved or forgotten (marked done in the keychain itself, and for the Vault in the config, which config sync takes
  to other computers with the Vault). Until that has been done (a keychain that doesn't answer, a Vault whose passphrase
  prompt was cancelled), such a password isn't used. Changing its gateway, user name, domain or account forgets the
  password and asks again, as does removing the desktop; a sign-in that was under way when that happened (the server
  took its time) isn't saved when it ends, which would undo it. A new address takes it along, through the same gateway,
  unless a desktop is known at that address already, and behind an SSH host only along with its desktop's remembered
  certificate (below). Each store of passwords, Tabby's Vault and the keychain, forgets such a password on its own: at
  once where it can be read, and where it can't be just then (the Vault locked and its prompt cancelled, the keychain
  not answering) the password isn't used, and goes the next time that store can be read while the Tabby window is open;
  an edit or a removal says so, naming that store. Should the window be closed first, it is found again by a desktop at
  that address (**Sign in again…** in the desktop's menu replaces it). The desktop's remembered certificate stays
  meanwhile, so that a password still kept there goes only to the machine it was saved for: a removal keeps it while a
  store waits (Settings › Remote Desktop › Certificates can forget it), and a new address leaves it at the old one too,
  as well as taking it along, which also keeps another desktop's password at that address, reached another way, from
  going to a machine that isn't the one it was saved for.
- **Desktops that are xrdp only by a host's word ask before the password goes without Network Level Authentication.**
  0.5.0 stopped before sending the password to a server without NLA, except for desktops of the xrdp kind, which sign
  in that way by design. But a VM a host lists, a machine reached through a host, and the host's own desktop are xrdp
  only because that host says so: a host could call any server it offers xrdp and get the password typed for it as it
  is, and a host you sign in to with an SSH key need not have that password. Now only desktops you made xrdp ones (a
  desktop or profile of that kind) go on unasked; the others, the xrdp of the host you SSH into included, ask once, in
  xrdp's terms, and the answer is remembered for that desktop (with its certificate, below). A VM saved from a host's
  list is asked about the same way, one saved before this update too, until you pick its kind in its edit form, where
  the host's word is a choice of its own; the question says so. (A desktop of yours of the xrdp kind that starts a VM
  by name looks like such a VM, and asks once too.)
- **"Send the password anyway" is kept with the certificate it was given for.** Permission to sign in without Network
  Level Authentication was kept for the desktop alone, from before any certificate had been seen: an attempt that didn't
  get as far as one left it for whatever answered there next, which then got the password unasked, its certificate
  trusted as a first use. And it outlived **Trust the new certificate** and a new address in the edit form. It is now
  kept with the certificate accepted for that sign-in, and holds for that certificate only; trusting a changed one, a
  new address or forgetting the certificate takes it back, so another server there asks again, and the
  changed-certificate question says so. 0.5.0 kept the answer only until Tabby restarted (under Fixed, below), so none
  of its answers carries over; development builds since kept them without a certificate, and those ask once more.
- **A VM a host lists can no longer be given another desktop's saved password.** A found VM's address is part of the
  name its saved password is looked up by, and a host could list one at an address made up to read as a desktop
  configured behind it whose sign-in goes to an RD Gateway: opening that VM sent the desktop's saved password to
  wherever the host had it lead. A found VM's address is now an IPv4 address, the only kind the scan reports; others
  aren't listed.
- **`desk` requests need the machine's key, and act only in the pane you're in.** With `desk` on, anything shown in a
  console could ask Tabby to open that machine's desktop and run its setup there, as typing `desk` does: a file shown
  with `cat`, a log being followed, another machine's output. Tabby now acts only on a request that carries the key of
  the machine it is for, which only your account there can read and which the machine's setup gives Tabby when its
  desktop is opened with `desk` on. A setup run with `desk` off makes Tabby forget that machine's key as it starts,
  whatever the machine then says, so also when the setup fails or never finishes; one during which `desk` is turned off
  does when it ends or fails with `desk` still off (with `desk` on again by then, it changes nothing: a setup since
  keeps what it found), as does one that finds xrdp or Windows there instead of GNOME. Requests without a known key are
  dropped as they are read, with nothing shown, even while `desk` is off; of the others, a terminal passes on one every
  2 seconds, and a pane handles one at a time (timed by a clock that only goes forward: the time of day set back doesn't
  keep `desk` quiet meanwhile). A request from a pane that isn't the one in front, or that stops being it by the time
  the desktop would show (Tabby first asks the machine which one it is), gets a note there instead: shown there, the
  desktop would take the keyboard (and this computer's clipboard) from the pane you are typing in, even from another
  tab. The key tells `desk` apart from look-alike output, not from the machine itself, which can always send it, nor
  from a recording of `desk`'s output shown again there: open the desktop of a machine you don't trust with `desk` off.
  After updating, open each machine's desktop once before using `desk` there: that installs the new `desk` and lets
  Tabby recognize it. Tabby keeps a fingerprint of each key, not the key.
- **`desk` attaches the desktop's terminal only to your own sessions.** A request could name a tmux session that
  another user of the machine had opened to others, and the terminal on the desktop attached to it, where that user
  would see what you type. Now it attaches only to your own trd-pty sessions and to tmux servers in tmux's own folder
  for you, where no other user can replace a folder on the way; anything else gets a terminal in the folder instead.
  trd-pty, `desk`'s session helper, also checks that a session runs as you before sending it anything, doesn't use
  `/tmp` where another user could swap its folder, and starts no session (logins fall back to tmux) on a system that
  can't say which user is at the other end of a connection.
- **A desktop that finishes connecting while you're in another pane no longer takes the keyboard**, nor does a sign-in
  form (its own, or its gateway's) or a question (a certificate to trust) that shows up for it meanwhile, nor the tip
  shown on the first connection when it closes. They took it from whatever pane you had moved to, in another tab too
  (Tabby keeps those in the page, out of sight), so what you typed there went to that desktop, and this computer's
  clipboard went with the keyboard. The remote decides how long connecting takes, and when a dropped connection comes
  back. They now get the keyboard when their pane does, and a question waiting where it isn't in view brings a note
  that stays a few seconds.
- **Pasting a copied folder (⌘V) no longer sends what its links lead to outside it.** A folder can hold links to
  anywhere (one unpacked from an archive, or a repository), and the paste sent the files behind them too, a folder
  of keys as easily as a document. A link in a copied folder is now followed only when it leads somewhere in that
  folder; the others are left out, and the message on the desktop says how many. When that leaves no file to send,
  nothing is pasted (⌘V would have pasted whatever the remote had), and the message says why; the same where what was
  copied is gone, or is links that lead nowhere or folders with nothing in them. Folders dropped on a
  desktop weren't affected: Tabby's browser engine doesn't follow their links. Reading a copied folder holds Tabby up
  while it goes on, so besides its limits on what it sends (10,000 files and folders, 20 deep) it now stops at limits
  on what it looks at (20,000 names and folders, 2,000 links), and looks at nothing past them: a folder of a million
  names or links no longer holds Tabby up for long, and the message says when something was left out. A folder found
  swapped for another while it was read stops the paste, as one that can't be read does (⌘V pasted whatever the remote
  had).
- **A release ships IronRDP only as its sources build it.** The remote desktop itself (IronRDP's WebAssembly and
  JavaScript, in `vendor/`) is committed prebuilt and runs with Tabby's access to this computer, and nothing checked
  that it was what IronRDP and the plugin's patches build to: a changed or out-of-date build would have been published
  as it was. The build now records what it was made from and each file's hash (`vendor/SHA256SUMS`), every change is
  checked against that, and a release is staged only after CI has rebuilt IronRDP from source and found every file
  identical, byte for byte. The base commit has to be one of IronRDP's own (GitHub serves a fork's commits through
  IronRDP's address too), and the build's tools are pinned: wasm-bindgen is built from its own lock file rather than
  from the newest releases of what it uses (one of the right version built without it is built again; this release's
  WebAssembly is built so, and differs from 0.5.0's only in the version of a library of wasm-bindgen's it names), and on
  the Apple Silicon Mac `vendor/` is built on, binaryen's optimizer is checked against its hash before it runs, and is
  all that is kept of its release: the folder it is in goes ahead on PATH, so nothing else may be there. The package's
  IronRDP files, and every other committed file in it, are checked against the tagged commit in the repository, not
  against the copy of the list it carries, before it is staged, and a staged release can be checked the same way before
  it is approved, its built `dist/` against a build of your own. The patches' own tests now run in CI as well.
- **An SSH host can no longer freeze or crash Tabby with what it prints.** The plugin runs small commands on your SSH
  hosts (looking for VMs does so by itself while an SSH tab is active), and it kept all that a host printed in answer,
  then read it in a way that took far longer the more there was: a host that answered with a few megabytes of made-up
  VMs could freeze Tabby for a minute or more, a single long line could do it for hours, and a larger answer could
  crash it, closing every tab. An answer is now cut off at 4 MB (the plugin's commands print a few lines), kept as its
  bytes however small the pieces it comes in, and read in time that grows only with its size: the VM scans, Hyper-V's
  answers and the line that says how an `ssh` typed on a host ended are read line by line or by hand, not with
  patterns that a long line could make retry each way of splitting it. At most 256 VMs are listed for a host, and its
  menu says so when that cuts the list short. A command's minute now runs from the moment its channel is asked for, so
  a host that stops answering partway through starting one no longer keeps a VM scan or a desktop's setup waiting for
  good. A host whose scan fails waits a minute before it is asked again, as one that answered does. A command run
  through the `ssh` typed in a terminal that takes longer than a minute is now an error, rather than taken as finished
  with what it printed so far, and a tunnel through it keeps only the end of what ssh prints (a host's sign-in banner
  can be as long as it likes). The list of this computer's processes, read to find the `ssh` in a local terminal, is
  read the same way: a program with a long run of spaces in its arguments could freeze Tabby while it was looked at.
  A host's reason for an error is shown and logged as far as 1,000 characters (a Hyper-V host's answer, 1,024), and a
  line logged from a host's answer is kept as a copy of its own, not as part of the answer, which could keep megabytes
  in memory for each line. To find an `ssh` typed in a pane (to open the desktop of the machine it went to), the
  plugin has the host print a mark in the terminal of each `ssh` running there, which tells which one is the pane's;
  it kept every such mark the host printed while it answered, up to a minute, which could fill Tabby's memory as
  well. It now keeps only marks of the form its script prints, 64 at most.
- **A remote desktop's server can no longer freeze Tabby by sending its data in tiny pieces.** Each piece was joined
  to everything still waiting, so a message sent a byte at a time cost the square of its size, all of it on the thread
  that runs Tabby's window: a few megabytes could hold Tabby still for tens of seconds at a time, and more for far
  longer. Pieces are now joined once, when the message is complete, and the server's sign-in messages (a few
  kilobytes) may be 256 KB at most, instead of 16 MB. The same goes for what an RD Gateway sends. What waits for the
  rest of a message is copied into storage of its own rather than kept as it came, since a piece can be a few bytes of
  a much larger read: a gateway could otherwise have every read kept whole for a byte of a packet it never finishes,
  a gigabyte for one packet. What comes through an SSH host while the desktop's side isn't reading is kept the same
  way, as its bytes rather than the pieces they came in: 64 MB of it a byte at a time could take gigabytes. A server
  that answers the connection request with something other than RDP (a web server on that port, say) is refused at
  once, rather than waited on for the length its answer seemed to give.
- **A remote desktop has a limit on the files it keeps open through a shared folder.** The server decides how many files
  it opens there and when it closes them, and a hostile one could keep opening until Tabby's window could open no file
  or connection in any tab, or crashed. A desktop now has at most 1,024 files open at once (programs there keep far
  fewer), and all the desktops in a Tabby window 2,048 together, since they share the window's files; more are refused
  until some are closed. That leaves most of what a Tabby window may have open to its other tabs where it may have far
  more: on macOS (some 138,000, measured) and on Windows (8,192). On Linux that wasn't measured: where a Tabby window
  may have 4,096 files open or fewer, these 2,048 are half of that or more. A file counts until it has been closed, not
  from when the server asks for that (closing waits for what is under way on the file), and a file still being opened
  when the connection ended was left open until Tabby quit; it is closed now.
- **The desktop name overlay's settings can't become part of Tabby's window.** A color for the overlay could get past
  the plugin's check and be read as page content, which in Tabby's window runs as code; it took someone able to change
  your Tabby config (through config sync, say). The overlay is now built without reading anything as page content,
  and only plain colors are used (a name, `#hex`, `rgb()` and the like). Other odd values are handled too: an overlay
  font or size such as `constructor` is ignored, where it used to break the overlay and with it the connection of the
  desktop it was naming; an overlay duration or an idle shutdown time that is neither a number nor text no longer
  stops every desktop from connecting, nor does a desktop's port, address, name or other field of that kind (in its
  entry or its profile) stop that desktop and those listed with it. Such a field, or an item in the desktops list that
  is no entry at all (an empty one), no longer takes away the right-click menu of every SSH tab (Tabby's own items
  with it) or the lists of the settings page, nor does a profile's address, port, user name or gateway of that kind
  keep Tabby's profile selector from opening; a desktop behind a host with such a field can still be edited and
  removed, shown by what of it is text, or by its address. Whatever goes wrong with the overlay, reading its settings
  included, is logged rather than failing the connection; and a shortcut in the config that isn't text no longer
  breaks the settings page.
- **The GNOME desktop's generated password no longer shows in the host's process list on every connect.** Checking it
  went through a command whose arguments other users of the host can see, and with the password one of them could sign
  in to that desktop. It is now compared in the shell, and set through `grdctl`'s input where `grdctl` reads it from
  there; a `grdctl` that doesn't still gets it as an argument each time it is set that way (when the setup can't tell
  whether it is set already, too), so on a host shared with others the password can still be caught then.
- **A shared folder's hard links can't be used to change files elsewhere.** A file with more than one name (a hard link,
  as pnpm's `node_modules` and some backup tools make) is the same file under each name, possibly outside the shared
  folder, so through a read-write share the remote could change it there too. Such files (as their count of names is
  when the file is opened) are now read-only from the remote; reading them is as before.
- **The microphone shows in Tabby's header whenever a desktop gets it**, whatever tab is in front, and in full screen,
  which hides Tabby's header, at the top of the window in the middle (over the desktop in view, clear of a maximized
  window's close button and GNOME's system menu); its menu shows that desktop, or stops sending the microphone there. A
  desktop that starts receiving the microphone while it isn't showing also brings a note. The remote decides when it
  takes the microphone, and the red dot on the desktop was the only sign in Tabby: out of sight while the console was in
  front or the tab in the background, and partly covered by a note from the remote. Capturing still carries on while the
  desktop is hidden, so hiding it doesn't cut a call short. **Stop** holds for that desktop until you turn **Send the
  microphone** back on in its menu (or that Tabby window is closed), reconnects included, so a server can't get the
  microphone back by dropping the connection; the same switch keeps a desktop from getting it beforehand. Turning the
  Microphone setting off now stops it at once on every desktop, one still connecting included, also when it is changed
  in another window or the config file; turning it on still applies on the next connection. Importing an .rdp file says
  when the desktop will get the microphone, and no longer calls a file's request for it not applied while the setting is
  on.
- **Clipboard sharing can be narrowed or turned off.** The clipboard always went both ways: a desktop that had the
  keyboard got what was on this computer's clipboard, whatever was copied meanwhile and what was copied elsewhere
  before clicking back into it, passwords from a password manager included, and could put anything on this computer's
  clipboard, such as a command waiting to be pasted into a terminal. Settings › Remote Desktop › Settings ›
  **Clipboard sharing** now offers both ways (the default, as before), only from the remote desktop to this computer,
  or off, for text, pictures and files alike; a desktop can have its own, in its profile's settings (or its group's or
  type's defaults) or in the form of a desktop behind an SSH host, and the Clipboard menu on such a desktop says so.
  Only from the remote desktop stops the reading of this computer's clipboard altogether, so a desktop connected that
  way only gets an empty one from this side; off leaves the clipboard channel out of the connection. **Paste to all
  desktops** leaves out the desktops that don't take this computer's clipboard and says which, and files go only where
  the clipboard does. Applies on the next connection; narrowing it also stops the sending right away to open desktops
  that follow the setting, however it was changed (here, in another window, in the config file or by config sync),
  takes back the files offered to them (a paste still pulling them fails), and stops a paste to all desktops or a save
  of several files that is under way before its next step. Narrowing applies in full once those desktops reconnect. An
  .rdp file's `redirectclipboard:i:0` (`0`, `00`, `+0` or `-0`, on any of its lines) now turns the clipboard off for the
  profile it makes, where the import used to note it as not applied; a file can't turn it on, and without it the
  profile follows its group's and type's defaults, which the import's question names. Importing such a file for a
  desktop that already has a profile sharing the clipboard asks whether to turn it off there, rather than opening that
  profile as it is. A desktop configured twice behind a host gets the narrower clipboard of the two, and a desktop
  opened with a narrower clipboard while it is open already (from another profile for it, say) narrows the open one
  until it is closed, its reconnects included and when it is shown again after its server ended it; its Clipboard menu
  says so.
- **Paste to all desktops and Type into all desktops leave out the desktops that aren't showing.** In a split tab, a
  desktop whose console was in front of it (or behind a pane maximized over it, nearly transparent) still got the
  paste and every key typed into the others, passwords included, with nothing on screen saying so: its label was on
  the hidden desktop. Now only the desktops showing get them, and the menus count only those; a key held down when a
  desktop is hidden is still let go there.
- **An open remote desktop tab connects with its profile as saved.** Reconnect, Try again, automatic reconnects and a
  reconnect at a new size used the profile as it was when the tab opened, so a new address or account only applied once
  the tab was closed and the profile opened again. A tab whose profile now goes through an SSH profile no longer
  connects directly.
- **Files saved from a remote desktop are marked as downloaded**, as a browser marks its downloads, so the system's
  checks of downloads apply to them: on macOS, Gatekeeper's, for apps, scripts and installers opened from Finder; on
  Windows, SmartScreen's and Office's Protected View. They were saved without the mark, so none applied. Not every kind
  of file, or every way of opening one, gets those checks. A file that can't be marked (on a disk that keeps no such
  marks) is saved anyway, and the message says the system may not warn before opening it, also when a later file
  fails to save. A file that fails to be saved whole (on a full disk, say) isn't left there part saved. And what the
  remote sends now goes into new folders of its own (one whose name is taken in Downloads gets a number, as a file
  does, and each is made as it is chosen), never into a folder that was there before or made since, such as an app of
  yours, which the system wouldn't check again.
- **Names of files saved from a remote desktop can't be disguised with invisible characters.** The remote chooses the
  names, and invisible characters in one can change how it reads (one that reverses the text after it can make an
  app's name end in ".pdf"). Those and control characters are now taken out (but for the invisible tags of a flag such
  as England's, Scotland's or Wales', in such a flag: a region's code after a black flag, not text of any length), and
  names are saved composed (NFC). On Windows, characters it doesn't allow in names become `_`, dots or spaces at the
  end go, and a device's name (`CON`, `NUL.txt`), which would write to the device rather than a file, gets a `_` in
  front. Letters that look like others can still mislead.
- **The .rdp import dialog can't be dressed up to read as a different address.** A file's address, gateway, user name
  and domain are shown faithfully: control characters, right-to-left overrides, and zero-width and other characters
  that don't show (variation selectors, tags, fillers, blanks other than the space) are refused (but for the joiners
  between letters that Persian and Indic scripts write names with, in a user name or a domain), and a name written
  with international letters is shown and saved as the punycode it actually resolves to, a gateway's port kept, so a
  look-alike can't pose as a name you trust. The account is named with its domain (`CORP\alice`), and such
  characters in the file's own name show as �.
- **The user name no longer goes out before the server is checked.** The first thing sent to a server, before
  encryption, the certificate check and the stop at a server without NLA, carried the account's user name (a routing
  cookie IronRDP adds), readable on the way and kept by servers the plugin then refused. The plugin's proxy now leaves
  it out, and sends no request that still names the user. Servers don't need it: it is for load balancers that route by
  user name, which the plugin doesn't support.
- **The fallback to TLS without forward secrecy can no longer be set off by words.** Windows' own certificate rules
  out modern TLS in Tabby, so for it the proxy falls back to TLS 1.2 with RSA key exchange, which has no forward
  secrecy. It did so whenever an error's message named the reason, and a gateway or an SSH host can word its own
  errors; something on the network could also make the first handshake fail. It now falls back only on the TLS
  library's own refusal, not on an error with its code that the SSH channel or the gateway underneath passed on, and
  keeps to it only for a certificate that shows it rules out modern TLS, as Windows' does (one whose key usage can't
  be read doesn't). Otherwise the connection stops, saying something may be interfering, and the next one starts
  without the fallback. Later attempts of the same connection start with the fallback only once it worked with a
  certificate that was accepted, and go back to modern TLS first after an attempt with it that doesn't get that far
  (it fails, the server doesn't answer in time, or the attempt is closed first). A server whose TLS fails through the
  system `ssh` no longer leaves an error behind that nothing handles.
- **An RD Gateway's answer is no longer kept, however long it says it is.** A gateway, or whatever answered in its
  place on a first connection, could announce an answer of any length and send data until the step's time ran out,
  all of it kept and copied over and over, with Tabby crawling meanwhile. The page that comes with a gateway's refusal
  is now counted off and dropped as it arrives, its length must be a number and at most 256 KB, and the gateway's
  control messages are held to the 125 bytes the standard allows. A gateway that takes the connection and never
  starts TLS is given up on after 20 seconds, like the other steps, instead of being waited for, and a desktop closed
  while its gateway's sign-in is under way ends it, sending nothing more and closing its connection, rather than letting
  it run to those timeouts. A gateway could also freeze Tabby, or fill its memory, in ways that didn't depend on a
  length: a header line with a stray line break after a long run of spaces held Tabby still for seconds while it was
  matched; an administrator's message, which the log shows 300 characters of, was searched to its end, seconds for a
  long one, at any time during a session; and each of its pings was answered with a pong that waited to be sent, so a
  gateway that sent pings and read nothing had them pile up without end. Header lines are now split at their colon, and
  refused with a line break of their own; only as much of a message as the log shows is read; and only the latest ping's
  pong waits to go out, as the standard allows. And a gateway's messages (or a server's doings) can no longer grow a
  desktop's log without end: only its first ten messages are logged, and the log keeps its first 200 lines and at least
  its latest 2,000, saying how many it left out between them.
- **A remote desktop can't fill a shared folder's disk in an instant.** One request could make a file any size
  without sending what is in it: on disks without sparse files (HFS+, NTFS, exFAT) that took the space at once, from
  the whole disk, and elsewhere it made files that look petabytes long. Now the part of a file the remote sent no data
  for may be no larger than the free space of the disk the file is on (a disk mounted inside a shared folder counts
  for itself), less 1 GB (on a disk under 20 GB, a twentieth of its size). That part is counted from what the file
  has on disk, so growing a file again and again doesn't get past it, and desktops in a Tabby window take turns growing
  files on a disk, each checking the free space as the growth before it left it. Where files can have holes (APFS,
  ext4), the limit is for each file on its own, and what it allows takes no space until written. The remote is told that
  much less is free, so Explorer says before a copy that it won't fit. What the remote writes isn't limited: it takes
  space as any copy does.
- **A remote desktop gets files sent from here 16 MB at a time at most, and pasted ones are read in the
  background.** It could ask for all of a large file at once, as often as it liked: a pasted one was read in Tabby's
  window, holding it up meanwhile (a third of a second and a gigabyte of memory for a 1 GB file), a dropped or picked
  one into memory. A request for more than 16 MB of a file now gets an error, not part of it, which a remote could
  take for all of it (FUSE, through which xrdp and GNOME Remote Desktop read pasted files, asks for 1 MB at most, 16
  MB on systems with 64 KB pages). At most 64 MB is read for a desktop at a time; more requests wait their turn, and
  past 256 waiting they get an error, as does a request on a stream that has one under way (the remote numbers its
  streams, and couldn't tell which of two requests on one an answer is for). An answer counts only for the request it
  was made for, matched by a number of the plugin's own, not the remote's: one for a request that is no more (expired,
  or gone with the files offered) goes to no one. What is read for a
  desktop's remote, parts of files and a shared folder's reads, waits in Tabby's window until its server reads it, and a
  server that kept asking, and read what came back slowly or not at all, could fill the window's memory in seconds. Now
  what is read for it, beyond what has gone out through the desktop's connection (everything the connection sends
  counts, its other messages too), is at most 64 MB and one part more (16 MB at most), and about 8 MB more may wait on
  the way to the server. A server that reads nothing at all gets no more than that; while one that reads keeps asking,
  what waits can grow beyond it by as much as the proxy reads of the connection's other messages meanwhile. A file's
  size and errors, and a shared folder's answers other than its reads (the names in a folder, a file's details), are
  answered at once, outside that: a size or an error is about as large as the request it answers. A pasted file is read
  a part at a time on Node's background threads, so a slow disk or network folder no longer holds Tabby up. A request
  that can't be answered (for a pasted file replaced, removed or cut short since) gets an error, where it used to get no
  answer at all, or a short one. And only the file that was pasted is read: one put in its place since, a link or a
  pipe, isn't.
- **Other programs can no longer keep a desktop from connecting.** A desktop's local proxy takes four connections at
  a time, and anything on this computer, or a web page in a browser, could take all four without knowing the proxy's
  secret token: the desktop's own client was then turned away for as long as that went on. The token is now part of
  the proxy's address and checked before a connection is let in, connections from pages in a browser are refused
  whatever they have (sandboxed pages, which say they come from `null`, and extensions' included; the plugin's own
  client is in Tabby's window, a file's page), and the token is compared in a way whose time doesn't tell how much of
  a guess was right. Since the token is in the address, the plugin takes it out of IronRDP's errors, which name the
  address when it can't connect there, before they reach the desktop's status and its log (**Copy log**). A desktop
  closed while its proxy was starting no longer leaves the proxy running until Tabby quits, and one closed while it
  connects no longer gets a clipboard, a video decoder, sound, the microphone or shared folders that nothing would
  close.
- **The release workflow no longer takes whatever is newest.** It ran GitHub's checkout and Node.js actions by version
  tag, which can be moved to other code, and installed the newest npm 11, all in the job that can publish the package.
  The actions are now pinned to fixed commits, which Dependabot proposes updates to, and npm is the one that comes with
  Node.js 26.8.2 (npm 11.19.1) rather than a download of its own. Only the publishing job can get npm's publishing
  token, and it runs none of the dependencies' code: the package is built in a job of its own, and the publishing job
  stages that very file, taken by the SHA-256 that job reported (any job of the run could replace the file it passes
  on), without running any of its scripts.
- **The plugin needs ws 8.21.1 or later.** Before 8.21.1, ws let a connection send a message in any number of tiny
  pieces and kept them all; a program on this computer that found the plugin's local proxy could fill Tabby's memory
  that way and crash it, without knowing the desktop's token. A fresh install already got a fixed ws, but the plugin
  accepted 8.18 and later, so an older copy kept in Tabby's plugin folder (by another plugin, say) stayed in use.
  8.21.1 is now the minimum.
- **The update check has limits.** It asked npm for the latest version with no limit on time or size, so whatever
  answered in npm's name (a network that inspects TLS, say) could keep the request open for good or send without end
  into Tabby's memory. It now gives up after 15 seconds or 256 KB; the answer is a few KB.
- **A desktop that drops right after connecting no longer reconnects every second without end.** Connecting reset the
  waits between automatic reconnects, so a server that ended each connection at once, or a video decoder the browser
  kept taking back, had the plugin connect and sign in again every second. The waits now start over only once a
  connection has stayed up for 30 seconds: until then the usual 1, 2, 4, 8, 15 and 30 seconds apply, and automatic
  reconnecting stops after them. A video decoder taken back twice within ten minutes turns H.264 off for that desktop,
  as a decoding failure does, until Tabby restarts or the setting is turned on again.
- **An alternate spelling of a gateway is treated as the same gateway.** Its remembered certificate and the passwords
  saved for it are keyed by one canonical form (lower case, no trailing dot, international letters as punycode, IPv6
  compressed), so `RDGW.Example.com` and `rdgw.example.com` don't each get trusted on first use. A gateway setting that
  names no host (`gw..example`, a name with `#`, `?`, `@` or `%` in it) is refused rather than read as part of one. A
  gateway written with capitals, a trailing dot or international letters whose certificate was remembered asks once to
  trust it again, unless an authority this computer trusts vouches for it; its old entry leaves Settings › Remote
  Desktop › Certificates.
- **Removing or editing one desktop no longer drops a gateway's certificate, or one of a desktop at another address.**
  The keys that hold a desktop's remembered certificate and its "Send the password anyway" choice were matched by how
  they end, so a gateway's certificate, or a desktop whose address ended the same way, could go with it; they are
  matched exactly now. A new address no longer takes the place of what a desktop already there has (its certificate,
  sharpness or saved password), and where a desktop is known at the new address (its certificate remembered), the
  saved password doesn't move there either: that desktop's certificate would check out, and it would sign in with the
  password unasked. The edited desktop asks. Desktops at the same address behind different SSH hosts are still edited
  and removed together, since a desktop's keys don't say which host it was added behind; so a saved password behind a
  host moves only along with the certificate remembered for its desktop, which goes along and stays at the old address
  too. Without one (forgotten in Settings › Certificates, which keeps the password), it is forgotten instead: it would
  otherwise go, unasked, to whatever answered first at the new address behind its host, another host's desktop's
  password included.
- **A malformed .rdp file is reported instead of failing in silence.** A file whose contents named a built-in property
  (a line keyed `__proto__`, say) made the import stop with nothing shown; such a file is parsed without trouble now,
  and an import that does fail says why.
- **A server that chooses NLA with early user authorization is no longer cut off right after signing in** when it
  also sets the plain NLA flag: the plugin's proxy now reads that choice the way IronRDP does. And the proxy's stop
  before a password goes to a server without NLA can't be left out by mistake: it refuses such servers unless it is
  told otherwise, rather than letting them through.
- **The idle-shutdown watcher's folder and pid file on the SSH host are private**, as the plugin's folder is when the
  desktop's setup makes it. Made by the watcher first, they were readable by other users; ones made so before are
  made private the next time a watcher starts, the folder in `/tmp` it uses where the home folder can't keep them
  included (one that can't be made private isn't used).

**Changed**
- **The package no longer includes source maps** (`dist/*.js.map`). They pointed at TypeScript sources that were never
  in the package, so they were of no use to anyone installing it, and their long encoded lines are what package
  scanners flag as "long strings" (possibly packed code). The package is about 450 KB smaller unpacked. `npm run
  watch` still writes them, for debugging from the repository.

**Fixed**
- **"Send the password anyway" wasn't remembered.** The choice is meant to stay with that desktop and its certificate
  (listed with it under Settings › Remote Desktop › Certificates), but the setting it's kept in was missing from the
  plugin's defaults, and Tabby only saves settings a plugin's defaults name. The choice held until Tabby restarted and
  was never written to the config, so a desktop without Network Level Authentication asked again after every restart.
  A unit test now checks that every setting the plugin writes is in its defaults.
- **Turning `desk` off no longer turns a linked `~/.bashrc` or `~/.zshrc` into a copy** of the file it linked to (nor
  one with other names, hard links, into a file of its own), and removes only the line it added: a line of yours that
  merely ended like it went too, and one that mentioned it kept `desk` from adding its line at all. The line from
  before 0.2 is removed only as those versions wrote it. The rest of the file is written back byte for byte (a last
  line without its newline gets one), into the file itself, so its mode and owner stay; a read-only file is left as it
  is, and the desktop's log (Settings › Remote Desktop › Troubleshooting › Open desktops › Copy log) says so, as it
  does when the line can't be added. Should the writing fail part way (a full disk), what the file should hold stays
  in the plugin's folder there, and the log says where.
- **A machine reached with `ssh` typed in an SSH tab says why when that host's ssh can't reach it.** ssh ends its
  messages with CR LF, and the CR kept the plugin from recognizing the line that says how that ssh ended: a refused
  sign-in or a connection that failed came back as if it were the command's output, and the desktop's setup failed
  saying only that it gave no result. The failure is now reported in ssh's own words.
- **View only stays on for a desktop shown again after its server ended it**, as it does when it reconnects: shown
  with the Desktop toggle or picked in the menu, it came back taking the keys typed in its pane.
- **A reconnect at a new size reconnects the same desktop.** In an SSH tab with two of a host's desktops open, one in
  each pane, resizing the older pane with **Reconnect at the new size** opened the host's last used desktop there,
  which went to the other pane, rather than reconnecting its own.
- **trd-pty works for a user whose uid is 2^31 or more.** It read such a uid as negative on Linux, so a session and
  its client refused each other: the login went on as a plain shell, without tmux either, and the session it had
  started stayed behind.
- **Removing a Hyper-V VM's desktop no longer forgets what is kept for another desktop.** Its entry was read as one for
  127.0.0.1:3389, and removing it forgot the saved password and the remembered certificate of every desktop at that
  address behind an SSH host. What a VM signs in with, and its certificate, are its host's, for all of that host's
  VMs, and stay, as the question before removing it now says. A desktop's address is now read the same way wherever it
  is used, as it connects: removing one whose address was left empty, or whose port was written as `0` or as text such
  as `"03390"`, forgets what is kept for it, where it forgot nothing; and a remote desktop profile through an SSH
  profile whose port is written as text, such as `"03390"`, opens, where it said the desktop was no longer configured.

## 0.5.0

Shared folders, desktops behind an RD Gateway, Hyper-V VMs' consoles, more of what an .rdp file says, text sent as
typed; more care with addresses that come from someone else; and fixes from a review of the code.

**New**
- **Shared folders** ([#26](https://github.com/meanaverage/tabby-rdp/issues/26)): folders from this computer appear as
  drives on the remote desktop, under `\\tsclient` in Explorer, like mstsc's drive redirection. Settings › Remote
  Desktop › Settings › Shared folders: **Share a folder…**, each one read-write or read-only. Every desktop you connect
  to sees them; applies on the next connection. Windows mounts them (xrdp can, with FUSE); GNOME Remote Desktop
  doesn't serve drives. Files move at the drive's pace through the RDP connection, so this is for working with files
  in place rather than copying gigabytes; the clipboard still carries files either way. The remote gets the folder
  and nothing else: `..` and symbolic links that lead out of it don't resolve, and only files and folders are served.
  File operations run in the background (Node's thread pool), one request at a time, so a slow disk or network
  folder slows the drive, not Tabby's window.
- **Hyper-V VMs** ([#28](https://github.com/meanaverage/tabby-rdp/issues/28)): on a Windows SSH host that runs
  Hyper-V, its VMs are listed among the host's desktops (`Get-VM`, with PowerShell over the SSH connection), and one
  that is off is started when opened. What opens is the VM's console, through the host (port 2179), as Hyper-V
  Manager's Connect does: no network or Remote Desktop needed in the VM. A Windows guest that is up gets an enhanced
  session; otherwise it is the basic console. The sign-in is the host's, asked once per host; an account the host
  signs in but doesn't let open the console (it ends the connection at once) brings the form back, saying so.
- **RD Gateway** ([#29](https://github.com/meanaverage/tabby-rdp/issues/29)): a remote desktop profile, or a desktop
  behind an SSH host, can name a Remote Desktop Gateway (**RD Gateway**: `rdgw.example.com`, or `host:port`). The
  connection then goes to the gateway over HTTPS (its WebSocket transport, Windows Server 2012 R2 and later), signs in
  there with a user name and password, and is connected on to the desktop, whose address is as the gateway sees it.
  The desktop's sign-in is the gateway's too unless the profile picks a saved account for the gateway. A sign-in the
  gateway refuses brings the form back saying it was the gateway, before anything goes to the desktop; a desktop its
  policy doesn't allow, or that it can't reach, is an error saying which. The gateway's certificate is accepted when
  valid for its name and otherwise remembered on first use; a changed one stops the connection until it is trusted.
  The sign-in (NTLMv2) is bound to the gateway's TLS certificate, which gateways require by default. Smart cards,
  sign-in pages and one-time codes at the gateway aren't supported.
- **.rdp files** ([#27](https://github.com/meanaverage/tabby-rdp/issues/27)): an import applies the file's display
  scale (`desktopscalefactor` 150 or more becomes the desktop's Retina sharpness) and its RD Gateway
  (`gatewayhostname`, unless the file turns it off), and says which of its other settings the plugin doesn't apply
  (sound left on the remote or off, a fixed window size, its own drives (shared folders are a setting here), printer,
  smart card or USB redirection, several monitors, RemoteApp, an account of its own or a smart card at the gateway),
  instead of ignoring them silently.
- **Send text as typed** ([#31](https://github.com/meanaverage/tabby-rdp/issues/31)), a setting: the characters the
  keyboard produces go to the desktop rather than key positions, so dead keys and a layout the remote doesn't have
  come out right; keys with Ctrl, Alt or ⌘ still go by position, so shortcuts keep working. Off by default. Windows
  types any character; a GNOME desktop only those its own layout has. Input methods (Chinese, Japanese, Korean) need
  more than this and stay open in #31.
- IronRDP's web client gains drive redirection (MS-RDPEFS) through a JavaScript file system (patch 15), and its
  static channels send multi-chunk messages Windows accepts (patch 16): a response over 1600 bytes was flagged for the
  receiver to keep the channel header, which Windows' drive redirector didn't expect and dropped the channel on.

**Safer with addresses that come from someone else**
- **Importing an .rdp file asks first**, naming the address, the gateway and the account the file leads to, with
  **Add and connect**, **Add only** and **Cancel**. It used to add the profile and connect at once. Nothing in a file
  runs on this computer (and a program it names for the remote isn't asked for), but a file decides where your
  sign-in goes.
- **A Windows desktop whose server doesn't use Network Level Authentication stops before the password is sent.**
  Without it the password goes to the server as it is (encrypted on the way, readable to whatever answered), which a
  server posing as a Windows machine can ask for; the first certificate being trusted on sight, nothing stood in the
  way. The connection now stops when the server's answer says so, before TLS, and asks: **Send the password anyway**
  (remembered for that desktop, shown and forgotten with its certificate under Settings › Remote Desktop ›
  Certificates) or **Cancel**. xrdp signs in this way by design: desktops of the xrdp kind aren't asked about.

**Fixed**
- **Save to Downloads** couldn't be led elsewhere by the remote's file names alone, but could by a link already in
  Downloads with a name the remote chose (a folder name, say). Folders are now made one at a time and must stay inside
  the folder once links are followed, and each file is created new: an existing name, link or not, gets a number.
- **Large files copied from the remote** were held in memory, twice over while being saved. They now arrive in a
  private temporary file and are moved into place.
- **The plugin's local proxy** (loopback, one per desktop) kept whatever a local program sent before showing the
  session's token, with no limit or deadline, and an error on such a connection wasn't handled. The first message is
  now capped at a request's size and has ten seconds to arrive, at most four clients connect at once, and messages
  are capped at 32 MB. Reaching the server has a deadline too.
- **A connection given up while the server was being reached** (the tab closed, Cancel) left that connection open
  until it finished; closing a desktop could leave an idle proxy connection behind. Both end at once now.
- **Data waiting for a slow side** was buffered without limit. The proxy now pauses the side it reads from while the
  other has more than 8 MB waiting, and a desktop reached through SSH whose data isn't being read at all is closed at
  64 MB rather than growing.
- **Dropping files on a desktop after a reconnect** (a wrong password first, a certificate question) offered them
  once per connection attempt, through handlers the earlier attempts left behind.
- **Shortcut modifiers could stay held on the remote:** turning on view only, or turning off typing into all
  desktops, by a shortcut sent the modifiers' key-down to the remote but not their release. Keys held at that moment
  are released first.
- **H.264: small changes far apart** (a clock in one corner, a cursor in another) read back everything between them:
  33 MB for a 4K picture to get a few pixels. Regions far apart are read one by one (IronRDP patch 17).
- **A desktop whose server went away could stay on screen, frozen.** Through an SSH host, a server that closes the
  connection (a machine shut down, a VM stopped) is reported as the end of what it sends, and not always as closed;
  the plugin waited for "closed", so the desktop sometimes stayed up, still marked connected, with no reconnect. The
  end of the server's side now ends the desktop, and reconnecting takes over as for any drop.
- **Linux without an unlocked keyring: Tabby could stop opening connections.** A keychain call there never returns
  and keeps one of Node's four worker threads waiting. The plugin gave the keychain up after the first such call, but
  calls started together (the settings page asking whether each saved account has a password, a desktop signing in
  meanwhile) each kept a thread first, and with all four taken, Tabby's file access and name lookups waited forever:
  a new SSH tab stayed at "Connecting". Keychain calls now go one at a time, so at most one thread is ever kept.

## 0.4.1

Fixes from a review of 0.4.0.

**Fixed**
- **Two desktops saving a password at the same moment** could lose one of them: Tabby's Vault rewrites its whole
  contents per change. The plugin's Vault changes now go one after another.
- **A saved account took the desktop's old domain:** an account with a plain user name and no domain was signed in with
  the domain the desktop had been given before, a field the form hides once an account is chosen. The account's domain
  (also none) is what is used.
- **A profile group's account didn't reach profiles reached through an SSH profile** in that host's tab menu; it does
  now, as it did when opening the profile itself.
- **"Ask for the account" on a new profile from the settings page** could be overridden by the "Remote desktops"
  group's default, since the group was assigned after the editor closed. The profile is in the group before the editor
  opens.
- **Removing an account** also clears a profile group default that named it, and says so when the password itself
  couldn't be removed. A desktop whose account is gone asks for one, rather than signing in with a login of its own
  saved earlier. A sign-in prompt left open while its account was removed or renamed no longer saves under it.
- **Editing an account's user name** keeps the old name when the old password couldn't be removed, so the two never
  disagree; a password kept for an account's earlier user name isn't used for the new one. A new account whose password
  couldn't be saved isn't added.
- **Hotkey collisions** are found among all of Tabby's bindings, per-profile and per-group hotkeys included, and named
  by the profile or group; the note says only one of the two would act.
- The settings page checks the accounts' passwords one after another, and not at all once the keychain has stopped
  answering, so a Linux keyring that doesn't answer can't hold every keychain worker.
- Cancelling or finishing **New account…** brings the user name fields back; the Vault lists a saved account's
  password by the account's name, as intended.

## 0.4.0

**New**
- **Saved accounts** ([#11](https://github.com/meanaverage/tabby-rdp/issues/11)): a user name and domain under a
  name, with the password kept once, for desktops that share an account. Chosen in a remote desktop profile's
  **Account** field or in the form for a desktop behind an SSH host (**New account…** there adds one), or for a whole
  profile group through the group's defaults. Listed, added, edited and removed in **Settings › Remote Desktop ›
  Accounts**, which names the desktops using each account. A password a server refuses is asked for again and saved
  for every desktop; **Sign in again…** asks anew.
- **Passwords in Tabby's Vault** when it is enabled, as Tabby keeps SSH passwords: encrypted, and carried by config
  sync. The system keychain as before otherwise, and still read for what was saved before the Vault was turned on.
- **Configurable shortcuts** ([#15](https://github.com/meanaverage/tabby-rdp/issues/15)): view only, a screenshot,
  Ctrl+Alt+Del, typing into all desktops of a tab, pasting to all of them, the connection status and Disconnect join
  the desktop/console switch as Tabby hotkeys, set on the settings page in the look of Tabby's Hotkeys page (or
  there). A key another hotkey already has is refused, and collisions made elsewhere are shown.
- **The settings page in tabs** — Getting started, Settings, Overlay, Desktops, Accounts, Troubleshooting — as
  Tabby's Profiles & connections page is, with the settings grouped (Picture, Sound, Keyboard, SSH hosts, Updates)
  and the detail behind ⓘ tooltips. The Desktops tab lists remote desktop profiles as well as desktops behind SSH
  hosts, and adds, edits and removes both; profiles the plugin makes go into a "Remote desktops" group.
- **A clearer reason when a connection fails** before it is up ("10.3.0.5:3389 did not answer"), in place of
  IronRDP's "general error (code 1)".
- The **name overlay preview** says which desktop resolution it stands for, and lets you pick one
  ([#16](https://github.com/meanaverage/tabby-rdp/issues/16)).

**Fixed**
- **The window could not be moved by its tab bar while a dialog was open**
  ([#19](https://github.com/meanaverage/tabby-rdp/issues/19)), the plugin's and Tabby's alike. Each dialog keeps a
  strip the height of the tab bar draggable. Submitted to Tabby as well.
- **A stale update notice** in a Tabby left open across several releases
  ([#17](https://github.com/meanaverage/tabby-rdp/issues/17)): opening the settings page with an update known asks
  npm again.
- Opening the settings page no longer prompts for the Vault passphrase.

**Docs**
- README: saved accounts, shortcuts, and where passwords are kept. Tabby's Vault page labels the plugin's secrets
  generically until Tabby ships [#11765](https://github.com/Eugeny/tabby/pull/11765)
  ([#18](https://github.com/meanaverage/tabby-rdp/issues/18)).

## 0.3.4

**Fixed**
- **Paste to all desktops in a tab** pasted this computer's clipboard only on the desktop with the focus; the others
  pasted whatever they had copied last. Since 0.3.2 only the focused desktop follows the clipboard, so the text or
  picture is now sent to each desktop before its paste. The paste shortcut while typing into all desktops does the
  same.

## 0.3.3

**Fixed**
- **H.264 video from a hostile remote desktop:** the server picks which parts of a video frame the plugin reads back
  from the browser's decoder, and nothing limited how much. One region larger than the picture, or many overlapping
  copies of the whole screen, could make it allocate enough memory to crash Tabby along with every tab in it. What a
  frame reads back is now bounded by the screen it draws on (overlapping regions are read once, as the box around
  them), and a frame that would still need more than 256 MiB is decoded without reading anything back (IronRDP
  patch 8). H.264 is on by default, so this applies wherever the browser decodes the video.

**Docs**
- The README's table of upstream IronRDP changes lists the keyboard API (#2026), says the Progressive decoding fix is
  covered by IronRDP #2010 and #1977, and says what each patch not submitted yet waits for.

## 0.3.2

**New**
- **Shut down VMs it started:** a VM the plugin started to open its desktop can go back off after 5 minutes, 15 or an
  hour with no desktop open (a setting; never, by default). A watcher on the SSH host sees to it, so it also works after
  the tab is closed or Tabby has quit.

- **A GNOME desktop that's open elsewhere** (another computer, or another Tabby window): opening it asks whether to
  take it over, as Windows does (the other connection is disconnected; the session and its apps carry on), or to open
  a second screen, which is what happened before. A desktop taken over doesn't take itself back.

**Better**
- **The headless GNOME session** runs X11 apps (through XWayland), and GNOME's settings daemons for keyboard, media
  keys and custom shortcuts, accessibility and sound; not power, so it never suspends the machine. A session that's
  already running gets them on the next connect, without closing its apps.

**Fixed**
- **A blank desktop after reconnecting** (GNOME): when the server sent the end of the connection sequence and the start
  of the graphics channel together, IronRDP lost the latter and the desktop stayed transparent. The proxy now hands it
  each server message on its own.
- **The clipboard with several desktops open:** closing one desktop stopped the automatic clipboard for the others,
  and a desktop in the background could overwrite what was copied on another. The desktop with the focus syncs the
  clipboard; copies made on another reach the Mac when it gets the focus (IronRDP patches 12 and 13).
- IronRDP patch 14, meant for upstream: H.264 pictures read correctly in Safari, whose `copyTo` ignores the RGBA format.
- A closed desktop no longer leaves its pane's subscription and its label timer behind.
- The first-connect tip shows the desktop/console hotkey as text: a label from the config could carry markup into
  the page.

**Docs**
- The limitation about Win+R from macOS is gone: ⌃⌘ with a key has been the Windows key with it since 0.3.0.

## 0.3.1

**New**
- **New versions:** Tabby shows plugin upgrades only while its Plugins page is open, so tabby-rdp now says so itself.
  Once a day it asks npm for the latest version (nothing else is sent); a newer one gets a note once, an **Update
  available** item in the menus and a line on Settings › Remote Desktop, each leading to Tabby's Upgrade button.
  **Tell me about new versions** turns it off.

**Docs**
- The README's demo plays in the page (a GIF), on GitHub and on npm.

## 0.3.0

**New**
- **Settings › Remote Desktop:** getting started, every setting with a line on what it does, keys and tips, the
  desktops and certificates the plugin keeps, troubleshooting, and each open desktop's log to copy for a bug report.
  A tip the first time a desktop connects, and **What does this mean?** under a message that ends a connection.
- **Several desktops in one tab:** **Paste to all desktops in this tab** (text, pictures, or files copied here),
  **Type into all desktops in this tab** (a label on each says so while it's on), and **Make panes even**. As you
  click into a desktop, its name shows in its corner for a moment; when, and its font, size, place and color, are in
  the settings, with a preview.
- **Files copied in Finder** (Explorer, Files) paste on the desktop with ⌘V (Ctrl+V), and the paste waits until the
  remote has taken them in.
- **VMs on a host:** the libvirt VMs with a desktop on an SSH host (RDP answering, or Windows and shut off) show up in
  its menu, ready to open, or to start and open. **Find virtual machines on SSH hosts** turns it off.
- **`ssh` typed in an SSH tab:** **Desktop** and `desk` there open the machine it went to, through the tab's host, and
  Reconnect stays with it.
- **Remote desktop (RDP) profiles:** desktops as Tabby profiles, in their own tab: connect directly to an RDP server
  this machine reaches (LAN, VPN), or through an SSH profile. They show up in the profile list, quick connect
  (`user@host:port`), recent profiles and tab recovery. **Import an .rdp file…** turns a saved Remote Desktop
  connection into one.
- **Linux desktops through xrdp** (KDE, XFCE, MATE, …): the SSH host's own desktop is xrdp's when GNOME isn't there,
  and offered next to GNOME when both are; `kind: xrdp` for desktops behind a host. Signs in with the Linux account.
- **Windows as the SSH host:** an SSH host that is itself Windows (OpenSSH server) opens its own RDP desktop.
- **H.264 video decoding** (setting **Video decoding**, on by default), hardware-accelerated where Tabby's engine can:
  Windows desktops now use the graphics pipeline with H.264 for what changes like video, instead of bitmaps; GNOME
  uses it when its machine has a hardware encoder.
- **Microphone** (off by default): an app on the remote desktop that records gets your microphone, only while it
  records, with an indicator.
- **Send keys:** Ctrl+Alt+Del, Win+R, Win+L, Task Manager and more for Windows; Super, the app grid, Alt+F2 for GNOME.
  From a Mac, ⌃⌘ with a key is the Windows key with it (⌃⌘R for Win+R).
- **View only**, **Save a screenshot** (to Downloads and the clipboard), and **actual size** with scroll bars for a
  fixed resolution.
- **Certificates:** GNOME desktops accept only the certificate the plugin made for them; other desktops remember theirs
  on first use and stop to ask, before signing in, if it changes.
- **Edit a desktop** behind a host from the menus (name, address, account, kind).
- **Wake before connecting:** `wake: { vm }` starts a libvirt VM on the SSH host, `wake: { mac }` sends Wake-on-LAN,
  when the desktop doesn't answer.
- **Connection status** (off by default): throughput, frames per second, SSH round trip and how it's connected, in the
  desktop's corner.

**Fixed**
- `desk` run on another machine than the tab's (after `ssh` there, or with a shared home folder) opened a terminal on
  the wrong desktop; it's refused now, with a note that says why.
- Windows over the graphics pipeline: IronRDP's RemoteFX Progressive decoder rejected Windows' refinement passes and
  ended the session (patch 0010, for upstream).

**Package**
- IronRDP's WebAssembly ships as its own file instead of a 6.6 MB base64 string inside the JavaScript: the package is
  about 2 MB instead of 2.7 MB.
- Releases are built and staged on npm by GitHub Actions, with provenance.

**Changed**
- Hosts are called by their SSH profile's name (not its address) in messages and the on-screen name.
- **Remove a desktop** asks first.
- **Menus:** the plugin's items in a terminal's or tab's menu start with a **Remote Desktop** heading (naming the
  desktop while one is connected), so they read as the plugin's rather than Tabby's. Under it the items are shorter:
  **Send files…**, **Disconnect** and **Settings**, and the host's other desktops (and VMs found there) and
  **Add a desktop behind \<host\>…** are under **Desktops**.

## 0.2.7

(0.2.6 carries the same change: its staged publish on npm looked like it had failed and only appeared later, so the
change was released again as 0.2.7.)

**Security**
- Files copied on the remote desktop are saved inside the folder you save them to (Downloads). Their names come from
  the remote, and a name with `../` and forward slashes could be written elsewhere, such as a folder where macOS
  starts programs at login. Now every part of the path is checked, and a file that would land outside is refused.
  Update if you use **Save to Downloads** with machines you don't fully trust.

## 0.2.5

**New**
- Sharpness per desktop: in the menu of a tab with a desktop open, **For \<desktop\> only**: As above, Standard or
  Retina. For example, Retina for a Windows VM and Standard for a GNOME host. Kept in the config
  (`remoteDesktop.desktopSharpness`).

**Fixed**
- Retina on Windows: Windows stayed at 100%, so its UI was tiny at device pixels. It takes the scale from the monitor
  layout only together with the monitor's physical size, which the plugin now sends; Windows follows every change of
  the setting, also back to 100%.
- Going from Retina back to Standard left GNOME at its Retina scale.

## 0.2.4

Tabby on Linux, tested end to end for the first time (Ubuntu 24.04 on arm64, Tabby 1.0.237):
- Keychain calls give up after 10 seconds. On Linux, a locked or missing keyring can keep them waiting for an unlock
  prompt that never appears; loading a saved Windows password then counts as none saved, and the sign-in form asks.
  After one such call, the plugin leaves the keychain alone for the rest of the session: each call that never returns
  holds one of the few worker threads Tabby's other file and network work needs.

Also:
- Works with IronRDP builds that have no switch for the graphics pipeline, such as one with a pending IronRDP change
  that turns it on by itself ([Devolutions/IronRDP#1977](https://github.com/Devolutions/IronRDP/pull/1977)).

## 0.2.3

**Fixed**
Tabby on Windows, tested end to end for the first time (Windows 11, Tabby 1.0.237):
- The remote desktop didn't load ("A dynamic import callback was not specified"). The IronRDP modules now load
  through the page's own module loader.
- Remote commands could come back empty, so a desktop failed with "Remote setup gave no result". Tabby's SSH binding
  sometimes delivers a command's last output after the channel's close, and then drops it; the plugin now picks it
  up.

## 0.2.2

**Fixed**
- On a freshly set-up machine, GNOME desktops connected but showed nothing: PipeWire, which screen casting goes
  through, hadn't been started for the user when it was installed after the user's systemd was up. The plugin now
  starts it.
- Apps such as Terminal and Files took 25 seconds to open on the desktop: GNOME's portal wouldn't start without a
  graphical session. The headless session now provides one, as a regular login does.
- No sound from machines without sound hardware (VMs, servers): a virtual output is added when there is none.

## 0.2.1

Same as 0.2.0. (npm took long enough to make 0.2.0 available that it was published again under a new version.)

## 0.2.0

**New**
- Windows desktops, and other desktops an SSH host can reach, next to the host's own: added and removed from the
  menus (**Add a desktop behind \<host\>…**, **Remove a desktop**), with a sign-in form and an optional keychain entry.
- Files both ways through the clipboard: drop files on the desktop (or **Send files to the remote desktop…**) and
  paste them there; files copied on the remote offer **Save to Downloads**.
- Sound from the remote desktop.
- Mac shortcuts on macOS (on by default): ⌘ acts as Ctrl on the remote, and a ⌘ tap is the Windows key.
- Reconnecting: a dropped connection is noticed and reconnected by itself once SSH is back ("Reconnect SSH" when SSH
  is down); ended or failed desktops offer Reconnect / Try again.

**Fixed**
- While a desktop covered a pane, Tabby's shortcuts acted on the terminal underneath: ⌘V pasted into the hidden
  console, ⌘W closed the tab. Only switching tabs and returning to the console stay Tabby's now.
- Clipboard: IronRDP's component signaled `ready` before setting up the clipboard, so connections got none.
- A desktop froze instead of noticing that its SSH connection was gone.
- Retina: GNOME Remote Desktop could reset the scale right after a resize.
- Windows' self-signed RDP certificate failed TLS in Tabby; such desktops now use TLS 1.2 with RSA key exchange.

**Changed**
- The remote folder is now `~/.local/share/tabby-rdp` (was `tabby-remote-desktop`); existing installs are moved over
  on the next connection.
- IronRDP is built from a series of focused patches (`ironrdp/patches`).

## 0.1.0

First release: GNOME desktops in SSH tabs and in local terminals running `ssh`, one desktop per account, live resize
and Retina, text and image clipboard, and `desk` (opt-in) with the trd-pty shared session.
