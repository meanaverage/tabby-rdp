/**
 * What a server's certificate is checked against where an authority's word is enough to connect without asking (a
 * desktop connected to directly, an RD Gateway; see RemoteDesktopService.checkTrusted), why one that fails doesn't
 * pass, and what a certificate says of itself, in words for the user.
 */
import { createHash, X509Certificate } from 'crypto'
import * as tls from 'tls'
import { showable } from './unshowable'

let authorities: string[] | undefined | null = null
let systemRead = false

/**
 * The certificate authorities a server's certificate is checked against: Node's own list (Mozilla's, and any in
 * NODE_EXTRA_CA_CERTS) and those of this computer's own store, such as an organisation's authority an administrator
 * installed, where Tabby's Node.js can read that store (tls.getCACertificates, Node 22.15 and later). Read once.
 * Undefined: Node's own list alone, its default.
 */
export function certificateAuthorities (): string[] | undefined {
    if (authorities === null) {
        authorities = undefined
        const read = (tls as any).getCACertificates as ((type: string) => string[]) | undefined
        if (typeof read === 'function') {
            try {
                const own = read('default')
                try {
                    authorities = [...new Set([...own, ...read('system')])]
                    systemRead = true
                } catch {
                    authorities = own
                }
            } catch {
                authorities = undefined
            }
        }
    }
    return authorities
}

/**
 * Where the chain a server's certificate came with stands by the certificate authorities its connection was checked
 * against (see chainStanding): it leads to one of them, the certificate is self-signed, the chain ends at an authority
 * of its own that isn't one of them, or it stops short of one: at a certificate whose issuer isn't there (left out by
 * the server, or named by a certificate that issuer didn't sign), or whose issuer may not issue certificates.
 */
export type ChainStanding = 'authority' | 'self-signed' | 'unknown authority' | 'incomplete'

/**
 * The certificates of a `ca` list as a TLS library takes them, to end a chain with: by their SHA-256 fingerprints
 * (`AB:CD:…`, as Node writes them), and by their subject and public key (see nameAndKey), so that another certificate
 * of the same authority (its root cross-signed by another authority, which a server can send along) counts as it.
 */
interface Anchors {
    fingerprints: Set<string>
    keys: Set<string>
}

/** Anchors by the `ca` list they were read from. */
const anchorsByList = new WeakMap<object, Anchors>()

function anchorsOf (authorities: tls.SecureContextOptions['ca'] | readonly string[]): Anchors {
    const cached = typeof authorities === 'object' && authorities ? anchorsByList.get(authorities) : undefined
    if (cached) {
        return cached
    }
    const found: Anchors = { fingerprints: new Set(), keys: new Set() }
    for (const item of [authorities ?? []].flat()) {
        for (const pem of String(item).matchAll(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/g)) {
            const der = Buffer.from(pem[1].replace(/\s/g, ''), 'base64')
            const hex = createHash('sha256').update(der).digest('hex').toUpperCase()
            found.fingerprints.add(hex.replace(/(..)(?!$)/g, '$1:'))
            const key = nameAndKey(der)
            if (key) {
                found.keys.add(key)
            }
        }
    }
    if (typeof authorities === 'object' && authorities) {
        anchorsByList.set(authorities, found)
    }
    return found
}

/**
 * A certificate's subject and public key (from its DER), by which an authority is known whichever of its certificates
 * comes: a certificate below it was signed with that key. '' when it can't be read.
 */
function nameAndKey (der: Buffer): string {
    try {
        const certificate = new X509Certificate(der)
        return `${certificate.subject}\n${certificate.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`
    } catch {
        return ''
    }
}

/** Whether `issuer`'s key made the signature on `certificate` (both as Node reads them: their DER is `raw`). */
function signedBy (certificate: tls.PeerCertificate, issuer: tls.PeerCertificate): boolean {
    try {
        return new X509Certificate(certificate.raw).verify(new X509Certificate(issuer.raw).publicKey)
    } catch {
        return false
    }
}

/**
 * Whether a certificate (its DER) names itself as its issuer and is signed with its own key, whatever its key usage.
 * Node makes such a certificate its own issuer only where its key usage allows signing certificates, which that of
 * Windows' own RDP certificate (key and data encipherment) and of a self-signed gateway's often don't.
 */
function selfSigned (der: Buffer): boolean {
    try {
        const certificate = new X509Certificate(der)
        return certificate.issuer === certificate.subject && certificate.verify(certificate.publicKey)
    } catch {
        return false
    }
}

/** Whether a certificate (its DER) may issue others: an authority by its basic constraints (and key usage, if any). */
function issuesCertificates (der: Buffer): boolean {
    try {
        return new X509Certificate(der).ca
    } catch {
        return false
    }
}

/**
 * Where the chain of a server's certificate stands (see ChainStanding) by `authorities`: the `ca` its connection was
 * checked against, or Node's own list without one. From Node's reading of the chain (getPeerCertificate(true)), which
 * follows the certificates the server sent, then those authorities, by the issuer each certificate names. Each link is
 * checked here as the TLS library checks it: the certificate was signed with the next one's key, and the next one may
 * issue certificates (an authority by its basic constraints, or one of the authorities whatever it says: an old root
 * says nothing). So a certificate that only names an authority, or one signed with the key of an authority's
 * certificate for a server, doesn't count as that authority's. One of the authorities is known by its fingerprint, or
 * by its subject and key (see Anchors), as the TLS library takes it.
 *
 * Node's code for why a certificate isn't valid (TLSSocket.authorizationError) is the last of the TLS library's
 * checks that failed, and whoever makes the certificate can choose which: one that is marked for other uses than a
 * server's (INVALID_PURPOSE), or that has expired, gets that code whoever issued it, a made-up authority included.
 * This says what the code can hide.
 */
export function chainStanding (certificate: tls.DetailedPeerCertificate, authorities?: tls.SecureContextOptions['ca']): ChainStanding {
    const anchors = anchorsOf(authorities ?? certificateAuthorities() ?? tls.rootCertificates)
    const anchor = (c: tls.PeerCertificate) => anchors.fingerprints.has(c.fingerprint256) || anchors.keys.has(nameAndKey(c.raw))
    const seen = new Set<string>()
    let current: tls.DetailedPeerCertificate | undefined = certificate
    while (current?.raw && !seen.has(current.fingerprint256)) {
        if (anchor(current)) {
            return 'authority'
        }
        seen.add(current.fingerprint256)
        if (selfSigned(current.raw)) {
            return current === certificate ? 'self-signed' : 'unknown authority'
        }
        // Node also makes a certificate that names itself as its issuer, but wasn't signed with its own key, its own
        // issuer: the one that signed it isn't there.
        const issuer: tls.DetailedPeerCertificate | undefined = current.issuerCertificate
        if (!issuer?.raw || issuer.fingerprint256 === current.fingerprint256 || !signedBy(current, issuer) || !(issuesCertificates(issuer.raw) || anchor(issuer))) {
            return 'incomplete'
        }
        current = issuer
    }
    return 'incomplete'
}

/** Server authentication, in an extended key usage. */
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

/** Whether a certificate's details (see CertificateDetails) mark it for other uses than a server's. */
function otherUses (details: CertificateDetails | undefined): boolean {
    return !!details?.extendedKeyUsage && !details.extendedKeyUsage.includes(SERVER_AUTH)
}

/**
 * Why a certificate isn't valid for `name` by those authorities, in words. Where the plugin checked it itself
 * (`details` with a `chain`, see certificateDetails): first where its chain stands, unless it leads to an authority
 * this computer trusts (otherwise nothing in the certificate is any authority's word); then whether it was issued for
 * another name, its dates and the uses it is marked for; and, for a chain that leads to an authority, what else the
 * TLS library found (Node's code, from TLSSocket.authorizationError), which is then about another certificate in the
 * chain, or a check of the library's own. Without those checks, from Node's code alone. An unknown code is named as it
 * is.
 */
export function whyNotValid (reason: string, name: string, details?: CertificateDetails): string {
    certificateAuthorities()
    // The server sent its authority's own certificate, which this computer doesn't trust. Without the system's store,
    // an organisation's own authority is one Tabby doesn't know, whatever the computer trusts: said so rather than
    // claimed otherwise.
    const untrusted = systemRead
        ? 'it isn\'t from a certificate authority this computer trusts'
        : 'it isn\'t from a certificate authority Tabby checks against (the public ones; an organisation\'s own counts as unknown here)'
    // No way to an authority from what the server sent: the issuer a certificate names is its own word. Windows fetches
    // an intermediate certificate a server leaves out by itself; Node doesn't. But that is no likelier than a
    // certificate naming an issuer that never signed it, which anyone can make.
    const incomplete = `no certificate authority ${systemRead ? 'this computer trusts' : 'Tabby checks against (the public ones; an organisation\'s own counts as unknown here)'} ` +
        'vouches for it from what the server sent (a server can leave out an intermediate certificate, which Tabby doesn\'t fetch, but any server can name any issuer)'
    const selfSigned = 'it is self-signed (made by the server itself, as RDP servers make theirs unless given one), so no certificate authority vouches for it'
    const anotherName = `it was issued for another name than ${name}`
    const expired = 'it has expired'
    const notYet = 'it isn\'t valid yet (or this computer\'s clock is wrong)'
    const marked = 'it is marked for other uses than a server\'s (its extended key usage)'
    const chain = details?.chain
    if (chain) {
        const parts = chain === 'self-signed' ? [selfSigned] : chain === 'unknown authority' ? [untrusted] : chain === 'incomplete' ? [incomplete] : []
        // Node checks the name only once the chain checked out; the plugin checked it whatever the chain.
        const named = details.forName === undefined ? reason !== 'ERR_TLS_CERT_ALTNAME_INVALID' : details.forName
        if (!named) {
            parts.push(anotherName)
        }
        // From its own dates: the code can be another certificate's, or another check's.
        const now = Date.now()
        const from = Date.parse(details.validFrom)
        const to = Date.parse(details.validTo)
        const past = Number.isNaN(to) ? reason === 'CERT_HAS_EXPIRED' : to < now
        const early = Number.isNaN(from) ? reason === 'CERT_NOT_YET_VALID' : from > now
        if (past) {
            parts.push(expired)
        }
        if (early) {
            parts.push(notYet)
        }
        // An organisation's Remote Desktop certificate template can name only the Remote Desktop use, not a server's:
        // said so only of a certificate for this name whose chain leads to an authority this computer trusts.
        // Otherwise anyone may have made it so.
        const uses = otherUses(details)
        if (uses) {
            parts.push(chain === 'authority' && named ? `${marked}, as some organisations' Remote Desktop certificates are` : marked)
        }
        // A chain that leads to an authority, and a code that none of the above accounts for: it is about another
        // certificate in the chain (an intermediate one that has expired, one marked for other uses), or a check of the
        // TLS library's own.
        const accounted = reason === 'ERR_TLS_CERT_ALTNAME_INVALID' ? !named : reason === 'CERT_HAS_EXPIRED' ? past
            : reason === 'CERT_NOT_YET_VALID' ? early : reason === 'INVALID_PURPOSE' ? uses : false
        if (chain === 'authority' && !accounted) {
            parts.push(reason === 'CERT_HAS_EXPIRED' ? 'a certificate in its chain has expired'
                : reason === 'CERT_NOT_YET_VALID' ? 'a certificate in its chain isn\'t valid yet (or this computer\'s clock is wrong)'
                    : reason === 'INVALID_PURPOSE' ? 'a certificate in its chain isn\'t one that may vouch for it'
                        : `it couldn't be verified${reason ? ` (${reason})` : ''}`)
        }
        return parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}` : parts[0] ?? 'it couldn\'t be verified'
    }
    switch (reason) {
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
            return selfSigned
        case 'SELF_SIGNED_CERT_IN_CHAIN':
            return untrusted
        case 'UNABLE_TO_GET_ISSUER_CERT':
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
            return incomplete
        case 'INVALID_PURPOSE':
            // Without the chain checked, the code may stand for a certificate anyone made (see chainStanding).
            return `${marked}; it may also be self-signed, or not from a certificate authority this computer trusts`
        case 'CERT_HAS_EXPIRED':
            return expired
        case 'CERT_NOT_YET_VALID':
            return notYet
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
            return anotherName
        case '':
            return 'no certificate authority vouches for it'
        default:
            return `it couldn't be verified (${reason})`
    }
}

/**
 * What a server's certificate says of itself, to judge it by before trusting it: whom it was issued to (its subject's
 * common name, and the names and addresses it is for), who issued it (an authority one wouldn't expect there, such as
 * one that inspects a network's TLS, shows here), its dates, and the uses it is marked for. All of it is the server's
 * word, which only an authority that vouches for the certificate makes more: anyone can make a certificate that names
 * any issuer, an organisation's own included. And where the plugin checked it (a certificate that isn't valid for the
 * name it was checked against, see certificateDetails), what isn't the server's word: where the chain it came with
 * stands (`chain`, see chainStanding), and whether it was issued for that name (`forName`).
 */
export interface CertificateDetails {
    subject: string
    names: string[]
    issuer: string
    /** As Node writes them (`Oct  4 12:00:00 2026 GMT`). */
    validFrom: string
    validTo: string
    /** The uses its extended key usage names (their OIDs), if it has one: a certificate without one is for any use. */
    extendedKeyUsage?: string[]
    chain?: ChainStanding
    /** Whether it was issued for the name it was checked against (tls.checkServerIdentity: a host name or an address). */
    forName?: boolean
    /**
     * Its chain leads to an authority this computer trusts, but the TLS library refused the certificate for a reason
     * the plugin's own reading doesn't account for (see READ_REASONS): what it says of itself isn't that authority's
     * word.
     */
    unchecked?: boolean
}

/**
 * The codes of the TLS library's verdict (TLSSocket.authorizationError) that the plugin's own reading of a certificate
 * accounts for, as whyNotValid puts them: where its chain stands, its name, its dates and the uses it is marked for.
 * For a chain that leads to an authority this computer trusts, any other code is a check the library made and the
 * plugin doesn't (a limit the authority set on the names it signs for, on the length of a path, the strength of a key
 * or a digest, a revocation): the chain's standing says nothing of what the library refused there.
 */
const READ_REASONS = new Set([
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'INVALID_PURPOSE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/**
 * A certificate's details, from Node's reading of it (TLSSocket.getPeerCertificate(true)); undefined without one.
 * `checked`: it isn't valid for `name` by `authorities` (as its connection was checked), for Node's `reason`, and the
 * plugin checks it itself: where its chain stands, and whether it was issued for that name, which Node checks only
 * once the chain checked out. So a name Node found wrong (ERR_TLS_CERT_ALTNAME_INVALID) says the TLS library took the
 * chain to one of the authorities, whatever Node's reading of the chain shows (an issuer of the same name the server
 * sent ahead of the one that signed, say).
 */
export function certificateDetails (
    certificate: tls.PeerCertificate | null | undefined, checked?: { name: string, authorities?: tls.SecureContextOptions['ca'], reason?: string },
): CertificateDetails | undefined {
    if (!certificate || typeof certificate !== 'object' || !certificate.valid_to) {
        return undefined
    }
    const uses = Array.isArray(certificate.ext_key_usage) ? certificate.ext_key_usage.filter(use => typeof use === 'string') : undefined
    let forName: boolean | undefined
    if (checked) {
        try {
            forName = !tls.checkServerIdentity(checked.name, certificate)
        } catch { }
    }
    // A field can hold several values (two common names, say), which Node gives as an array.
    const text = (value: unknown) => Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' ? value : ''
    const issuer = [text(certificate.issuer?.CN), text(certificate.issuer?.O)].filter(Boolean)
    const chain = checked ? checked.reason === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'authority' : chainStanding(certificate as tls.DetailedPeerCertificate, checked.authorities) : undefined
    return {
        subject: text(certificate.subject?.CN),
        // `DNS:pc.example, IP Address:10.0.0.5`: the names and addresses, without their kind.
        names: typeof certificate.subjectaltname === 'string'
            ? certificate.subjectaltname.split(/, (?=[A-Za-z ]+:)/).map(name => name.replace(/^(DNS|IP Address):/, ''))
            : [],
        issuer: issuer.length === 2 && issuer[0] !== issuer[1] ? `${issuer[0]} (${issuer[1]})` : issuer[0] ?? '',
        validFrom: String(certificate.valid_from ?? ''),
        validTo: String(certificate.valid_to ?? ''),
        ...uses ? { extendedKeyUsage: uses } : {},
        ...chain ? { chain } : {},
        ...forName === undefined ? {} : { forName },
        ...chain === 'authority' && !READ_REASONS.has(checked?.reason ?? '') ? { unchecked: true } : {},
    }
}

/**
 * A certificate's details in a line: "Issued to <name> (<names>) by <issuer>, valid <from> to <to>." The server chose
 * all of it, so what could reorder or hide part of it shows as U+FFFD, and each part is cut short. `unchecked`: no
 * authority vouched for the certificate, so the line says that this is its own word, which nothing has checked: a
 * certificate anyone made can name the issuer one would expect, and the question shown with it is where that matters.
 * (One whose chain leads to an authority this computer trusts is that authority's word, whatever else is wrong with
 * it, unless the TLS library refused it for a reason of its own: see vouched.)
 */
export function describeCertificate (details: CertificateDetails, unchecked = false): string {
    const date = (text: string) => {
        const time = new Date(text)
        return Number.isNaN(time.getTime()) ? showable(text, 40) : `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    }
    const listed = details.names.slice(0, 8).join(', ') + (details.names.length > 8 ? `, and ${details.names.length - 8} more` : '')
    const what = `${showable(details.subject || '(no name)', 100)}${listed ? ` (${showable(listed, 300)})` : ''} ` +
        `by ${showable(details.issuer || '(no name)', 100)}, valid ${date(details.validFrom)} to ${date(details.validTo)}`
    return unchecked
        ? `It says it was issued to ${what}: its own word, which nothing here has checked; a certificate anyone made can say the same.`
        : `Issued to ${what}.`
}

/**
 * Whether what a certificate says of itself (`details`) is more than its own word: an authority vouched for it
 * (`valid`), or its chain leads to an authority this computer trusts, though the certificate isn't valid here (issued
 * for another name, expired, marked for other uses): an authority's word all the same, and the names in it are what
 * show it to be another machine's. Not where the TLS library refused the certificate for a reason the plugin's reading
 * doesn't account for (`unchecked`, see READ_REASONS): the authority's word may be limited, say to other names, in a
 * way nothing here checks.
 */
export function vouched (valid: boolean | undefined, details: CertificateDetails | undefined): boolean {
    return valid === true || details?.chain === 'authority' && !details.unchecked
}
