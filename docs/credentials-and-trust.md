[← README](../README.md)

# Accounts, saved passwords and certificates

## What changes when you edit a desktop?

These rules concern saved sign-ins and trust, and apply to Windows and Linux alike. Hyper-V consoles share their
host's sign-in and certificate rather than keeping guest credentials.

| Action | Saved password | Certificate and display settings |
|---|---|---|
| Change a behind-host desktop's address | Follows only with its remembered certificate, when the destination is not already known. Otherwise, the desktop asks again. | Sharpness and certificate follow unless the destination has its own; the old address keeps its certificate too. |
| Change its user name, domain, saved account or gateway | The desktop's previous saved password is forgotten. | A new address or forgotten certificate also requires a new no-NLA decision. |
| Remove a behind-host desktop | Its saved password is forgotten. | Its certificate is removed when the password can be cleared; see the locked-store case below. Hyper-V host state stays. |
| Edit or remove one of several RDP profiles at one address | Other users' saved passwords are left alone. A new sign-in identity asks again. | The address's certificate is left alone. |
| Change a shared saved account | Desktops using that account use the updated account password. | Each destination still has its own certificate checks. |

Behind-host entries use their destination address to find saved state. An edit or removal can therefore affect
entries for that address behind other SSH hosts. Direct profiles also scope passwords by user and gateway. Profiles
that name no user can reuse the password saved by another unnamed-user profile for that address.

## Saved accounts

A saved account is a login defined on its own: a name, a user name (and domain), and its password, stored once. Any
desktop can pick it instead of typing a user name into its profile, and both ways work: a profile's own user name keeps
its own saved password, per user, for that address. An account is handy for keeping logins in one place, and for one
used on several desktops (a domain admin, a lab user), whose password is then changed once for all of them.

**Settings › Remote Desktop › Accounts** lists them, with the desktops that use each one (click a name to open its
settings), and adds, edits and removes them. A desktop picks its account in its profile's **Account** field, or in the
form that adds a desktop behind an SSH host; **New account…** there adds one on the spot. A profile group's defaults
for **Remote desktop (RDP)** can pick an account for every profile in the group (**Profiles & connections**, the group's
menu), which is how to give a whole group of servers one sign-in.

Signing in with a saved account that has no password yet, or whose password a server refused, asks for it, and the
form saves what you enter as the account's new password for every desktop. A refused password is not dropped by
itself: one server refusing it doesn't make it wrong for the others. **Sign in again…** on such a desktop asks anew.

The accounts' names and user names are in Tabby's config (`remoteDesktop.accounts`); the passwords are in Tabby's Vault
when it is enabled (encrypted, and carried by Tabby's config sync), else in the system keychain. Removing an account
removes its password and sets its desktops back to asking, a profile in a group with a default account included: it asks
rather than take that default. A desktop's saved password that an edit or a removal forgets goes at once from each store
that can be read, Tabby's Vault or the keychain. In one that can't be just then (the Vault locked and its prompt
cancelled, the keychain not answering) it isn't used, and goes once that store can be read while the Tabby window is
open; an edit or a removal says so. Should the window be closed before that, it is found again by a desktop at that
address (**Sign in again…** in the desktop's menu replaces it). The desktop's remembered certificate stays too, so that
the password goes only to the machine it was saved for: a removal keeps it (Settings › Remote Desktop › Certificates can
forget it), and a new address leaves it at the old one too, as well as taking it along.

## How a user name is sent

Both clients send a user name the same way, whether it comes from a profile or a saved account:

| User name | Sent as |
|---|---|
| `DOMAIN\user` | Domain `DOMAIN`, user name `user`. The domain field is not used. |
| `user@domain.example` or `user` | The user name as typed, with the domain field (the saved account's, or the desktop's) if it is set. |
| A PAM proxy's bracketed name, such as senhasegura's `vault-user[DOMAIN\target-user@device]` | The whole name as typed, with the domain field if it is set. A name with a square bracket before its backslash is not split there, because the proxy reads its target from the whole user name. |

## Direct connection certificates

A direct connection is a plain TCP connection from this computer, encrypted with TLS like any RDP client's, with nothing
else between the desktop and the network on the way. So its certificate is checked as a browser checks a website's: one
valid for the desktop's name (or address) by the certificate authorities this computer trusts connects without a
question (an organisation's desktops often have one). Any other, such as the self-signed one most RDP servers make for
themselves, is shown on the first connection before anything of your sign-in is sent: the address, why it can't be
verified, its SHA-256 fingerprint and what it says of itself (whom it was issued to and by, and its dates), with **Trust
the certificate** and **Cancel** (what Enter picks). Why it can't be verified is Tabby's own reading of the certificate
(self-signed, from an authority this computer doesn't trust, issued for another name, expired, …), not only what the TLS
library reported last, which whoever makes the certificate can choose. What it says of itself is its own word, which
nothing has checked, unless its chain leads to an authority this computer trusts (where another machine's certificate
shows that machine's name) and the TLS library didn't refuse it for a reason of its own (a limit set on the authority,
say): an issuer you would expect there proves nothing. Check the fingerprint with whoever runs the desktop, some other
way than this connection, before you trust it. For a server without Network Level Authentication, the question says that
signing in would send it your password itself. Once trusted it is remembered.

A different certificate later stops the connection as above, whatever vouches for it. One an authority vouched for may be renewed: a
replacement it vouches for too connects, and the desktop's log says so. The same one connects only while that holds:
once it has expired, or its authority is gone from this computer's store, it is asked about as at first, since you never
confirmed it.

A certificate whose only use is Remote Desktop Authentication (as Active Directory's Remote Desktop
templates issue them) isn't valid for a server by Tabby's rules, whatever issued it, so it is asked about too, and again
when it is renewed. Trusting a certificate never allows signing in without Network Level Authentication, which is asked
about on its own.

## Certificates behind SSH

The first connection to a desktop behind a host remembers its TLS certificate, without asking (in Tabby's config,
under `remoteDesktop.trustedCertificates`): the way there runs inside SSH. SSH vouches for the host, though, not for
what answers behind it: a host you don't trust, or something on its network, could answer that first connection, so
make it where you trust both. If a later connection meets a different certificate, the plugin stops before signing in
and shows both fingerprints, with **Trust the new certificate** and **Cancel**. Reinstalling Windows or renewing its
certificate changes it; if neither happened, something else is answering at that address. Automatic reconnects stop at
the same question. A desktop allowed to sign in without Network Level Authentication is asked about that again once a
new certificate is trusted, or its address changes.

## Signing in without NLA

Windows normally uses Network Level Authentication (NLA), which proves knowledge of the password before a server
receives it. A Windows server without NLA is stopped and asks before the sign-in is sent. Trusting a certificate
alone does not allow a non-NLA sign-in.

xrdp signs in without NLA by design. A desktop you explicitly configure as xrdp can sign in that way; a host-discovered
xrdp desktop asks once first. Permission is tied to the server certificate. Changing the address or certificate, or
forgetting the certificate, asks again.

## Generated GNOME credentials

GNOME's generated password and TLS key belong to each SSH user and machine. They are kept under
`~/.local/share/tabby-rdp/hosts/<machine-id>/`, with private directory/file permissions. Linux needs a valid,
initialized `/etc/machine-id`; cloned machines must have distinct IDs. On the first connection after this change,
each machine gets new credentials and GNOME Remote Desktop restarts, disconnecting any existing RDP clients.
Reconnect to **every** machine using a shared home to rotate all active credentials. Old home-wide credential files
are preserved for machines still using an earlier version, but this version never imports them.

Separate credentials prevent accidental reuse across machines; they do not isolate machines that let the same
account read or write the shared home. That account can still read every machine's stored secrets and GNOME's own
shared configuration. Use separate accounts or host-local homes when those machines need independent trust.
