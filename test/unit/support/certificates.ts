// Certificates for the unit tests' stand-in servers, made with the openssl command: a certificate authority of the
// tests' own (which a test hands to the code as its `ca`, standing in for this computer's authorities), certificates it
// issues (authorities below it among them), its own as another authority issues it, certificates signed with the key
// of one it issued, and self-signed ones. Each returns null where openssl is missing or can't make it, for the test to
// skip.
// Not a test file itself: test:unit runs test/unit/*.ts only.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { isIP } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

export interface Certificate {
    key: Buffer
    cert: Buffer
    der: Buffer
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-ca-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
const read = (name: string) => fs.readFileSync(path.join(dir, name))
const derOf = (pem: Buffer) => Buffer.from(pem.toString().replace(/-----[^-]+-----|\s/g, ''), 'base64')
let made = 0

/** The number of each certificate made here that can issue others (`<n>.pem`, its key `<n>.key`), by its PEM. */
const numbers = new WeakMap<Buffer, number>()

/** A self-signed certificate for `name`, with `extensions` (openssl's -addext). */
export function selfSigned (name: string, ...extensions: string[]): Certificate | null {
    const n = ++made
    try {
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.pem`, '-days', '2', '-subj', `/CN=${name}`,
            ...extensions.flatMap(e => ['-addext', e]))
        return { key: read(`${n}.key`), cert: read(`${n}.pem`), der: derOf(read(`${n}.pem`)) }
    } catch {
        return null
    }
}

export interface Authority {
    /** Its certificate (PEM): what the code under test is given as `ca`. */
    ca: Buffer
    /**
     * A certificate it issues for `names` (host names, or IP addresses), with `keyUsage`, `extendedKeyUsage` and basic
     * `constraints` if given; `expired`: valid for a day in 2020 (openssl 3.4 or later; null with an older one).
     */
    issue (names: string[], options?: { keyUsage?: string, extendedKeyUsage?: string, constraints?: string, expired?: boolean }): Certificate | null
    /**
     * An authority it issues (basic constraints CA:TRUE, or `constraints`: a path length limit, say), named `name`,
     * with an extended key usage and name constraints if given.
     */
    below (name: string, options?: { extendedKeyUsage?: string, constraints?: string, nameConstraints?: string }): Authority | null
    /**
     * Its own certificate as `other` issues it: its name and key, `other` as its issuer (an authority's root
     * cross-signed by another authority, which a server can send along).
     */
    signedBy (other: Authority): Buffer | null
}

/** A certificate `<by>` issues for `subject`, with the key `<key>.key` (a new one without), and these extensions. */
function issued (by: number, subject: string, extensions: string, options: { key?: number, expired?: boolean } = {}): number {
    const m = ++made
    if (options.key === undefined) {
        openssl('genrsa', '-out', `${m}.key`, '2048')
    }
    openssl('req', '-new', '-key', `${options.key ?? m}.key`, '-out', `${m}.csr`, '-subj', `/CN=${subject}`)
    fs.writeFileSync(path.join(dir, `${m}.ext`), extensions)
    openssl('x509', '-req', '-in', `${m}.csr`, '-CA', `${by}.pem`, '-CAkey', `${by}.key`, '-CAcreateserial', '-out', `${m}.pem`, '-extfile', `${m}.ext`,
        ...options.expired ? ['-not_before', '20200101000000Z', '-not_after', '20200102000000Z'] : ['-days', '2'])
    return m
}

const AUTHORITY = 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n'
const authorityWith = (constraints = 'critical,CA:TRUE') => `basicConstraints=${constraints}\nkeyUsage=critical,keyCertSign\n`

/** What issues certificates with `<n>.pem` and `<n>.key`, which is named `name`. */
function issuer (n: number, name: string): Authority {
    const ca = read(`${n}.pem`)
    numbers.set(ca, n)
    return {
        ca,
        issue (names, options = {}) {
            try {
                const m = issued(n, names[0], `subjectAltName=${names.map(x => `${isIP(x) ? 'IP' : 'DNS'}:${x}`).join(',')}\n` +
                    (options.keyUsage ? `keyUsage=${options.keyUsage}\n` : '') + (options.extendedKeyUsage ? `extendedKeyUsage=${options.extendedKeyUsage}\n` : '') +
                    (options.constraints ? `basicConstraints=${options.constraints}\n` : ''),
                { expired: options.expired })
                const cert = read(`${m}.pem`)
                numbers.set(cert, m)
                return { key: read(`${m}.key`), cert, der: derOf(cert) }
            } catch {
                return null
            }
        },
        below (sub, options = {}) {
            try {
                return issuer(issued(n, sub, authorityWith(options.constraints) + (options.extendedKeyUsage ? `extendedKeyUsage=${options.extendedKeyUsage}\n` : '') +
                    (options.nameConstraints ? `nameConstraints=${options.nameConstraints}\n` : '')), sub)
            } catch {
                return null
            }
        },
        signedBy (other) {
            const by = numbers.get(other.ca)
            try {
                return by === undefined ? null : read(`${issued(by, name, AUTHORITY, { key: n })}.pem`)
            } catch {
                return null
            }
        },
    }
}

/** A certificate authority of the tests' own, named `name`. */
export function authority (name = 'tabby-rdp test authority'): Authority | null {
    const n = ++made
    try {
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.pem`, '-days', '2', '-subj', `/CN=${name}`,
            '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign')
    } catch {
        return null
    }
    return issuer(n, name)
}

/**
 * Certificates signed with the key of `certificate` (one an authority issued, see Authority.issue), naming it as their
 * issuer, whatever it may issue: as anyone holding a certificate an authority issued for a server could make them.
 */
export function signedWith (certificate: Certificate): Authority | null {
    const n = numbers.get(certificate.cert)
    return n === undefined ? null : issuer(n, '')
}
