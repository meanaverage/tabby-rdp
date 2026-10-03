import { createHash, createHmac, randomBytes } from 'crypto'

/**
 * NTLMv2 ([MS-NLMP]), as much as HTTP authentication needs: the three messages, no signing or sealing afterwards.
 * Written out here rather than taken from a package: it is small, and the password passes through it.
 */

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1')

const NEGOTIATE_UNICODE = 0x00000001
const REQUEST_TARGET = 0x00000004
const NEGOTIATE_NTLM = 0x00000200
const NEGOTIATE_ALWAYS_SIGN = 0x00008000
const NEGOTIATE_EXTENDED_SESSIONSECURITY = 0x00080000
const NEGOTIATE_TARGET_INFO = 0x00800000
const NEGOTIATE_VERSION = 0x02000000
const NEGOTIATE_128 = 0x20000000
const NEGOTIATE_56 = 0x80000000

// AV pairs of the server's target information.
const AV_EOL = 0
const AV_FLAGS = 6
const AV_TIMESTAMP = 7
const AV_TARGET_NAME = 9
const AV_CHANNEL_BINDINGS = 10
/** MsvAvFlags: the authenticate message carries a message integrity code. */
const AV_FLAG_MIC = 0x2

/** MD4 (RFC 1320). The password's hash is one; OpenSSL 3 and BoringSSL no longer offer it. */
export function md4 (data: Buffer): Buffer {
    const length = data.length
    const padded = Buffer.alloc(((length + 8 >> 6) + 1) * 64)
    data.copy(padded)
    padded[length] = 0x80
    padded.writeUInt32LE(length * 8 >>> 0, padded.length - 8)
    padded.writeUInt32LE(Math.floor(length / 0x20000000), padded.length - 4)
    let [a, b, c, d] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
    const rotl = (x: number, n: number) => x << n | x >>> 32 - n
    const x = new Array<number>(16)
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) {
            x[i] = padded.readUInt32LE(offset + i * 4)
        }
        const [aa, bb, cc, dd] = [a, b, c, d]
        const f = (p: number, q: number, r: number, s: number, k: number, n: number) => rotl(p + (q & r | ~q & s) + x[k] | 0, n)
        const g = (p: number, q: number, r: number, s: number, k: number, n: number) => rotl(p + (q & r | q & s | r & s) + x[k] + 0x5a827999 | 0, n)
        const h = (p: number, q: number, r: number, s: number, k: number, n: number) => rotl(p + (q ^ r ^ s) + x[k] + 0x6ed9eba1 | 0, n)
        for (const i of [0, 4, 8, 12]) {
            a = f(a, b, c, d, i, 3); d = f(d, a, b, c, i + 1, 7); c = f(c, d, a, b, i + 2, 11); b = f(b, c, d, a, i + 3, 19)
        }
        for (const i of [0, 1, 2, 3]) {
            a = g(a, b, c, d, i, 3); d = g(d, a, b, c, i + 4, 5); c = g(c, d, a, b, i + 8, 9); b = g(b, c, d, a, i + 12, 13)
        }
        for (const i of [0, 2, 1, 3]) {
            a = h(a, b, c, d, i, 3); d = h(d, a, b, c, i + 8, 9); c = h(c, d, a, b, i + 4, 11); b = h(b, c, d, a, i + 12, 15)
        }
        a = a + aa | 0; b = b + bb | 0; c = c + cc | 0; d = d + dd | 0
    }
    const out = Buffer.alloc(16)
    out.writeInt32LE(a, 0)
    out.writeInt32LE(b, 4)
    out.writeInt32LE(c, 8)
    out.writeInt32LE(d, 12)
    return out
}

const hmacMd5 = (key: Buffer, ...data: Buffer[]) => data.reduce((h, d) => h.update(d), createHmac('md5', key)).digest()
const utf16 = (text: string) => Buffer.from(text, 'utf16le')

/** NTOWFv2: what the password, user and domain come to. */
export function ntlmV2Hash (username: string, domain: string, password: string): Buffer {
    return hmacMd5(md4(utf16(password)), utf16(username.toUpperCase() + domain))
}

/** The first message: what this client can do. */
export function negotiateMessage (): Buffer {
    const message = Buffer.alloc(32)
    SIGNATURE.copy(message)
    message.writeUInt32LE(1, 8)
    message.writeUInt32LE((NEGOTIATE_UNICODE | REQUEST_TARGET | NEGOTIATE_NTLM | NEGOTIATE_ALWAYS_SIGN | NEGOTIATE_EXTENDED_SESSIONSECURITY |
        NEGOTIATE_128 | NEGOTIATE_56) >>> 0, 12)
    // Domain and workstation: none given (their fields point at the end, with no length).
    message.writeUInt32LE(32, 20)
    message.writeUInt32LE(32, 28)
    return message
}

/** The server's challenge message, read: its flags, its challenge and its target information. */
export function parseChallenge (message: Buffer): { flags: number, challenge: Buffer, targetInfo: Buffer } {
    if (message.length < 48 || !message.subarray(0, 8).equals(SIGNATURE) || message.readUInt32LE(8) !== 2) {
        throw new Error('not an NTLM challenge')
    }
    const flags = message.readUInt32LE(20)
    const [length, offset] = [message.readUInt16LE(40), message.readUInt32LE(44)]
    if (offset + length > message.length) {
        throw new Error('the NTLM challenge\'s target information is cut short')
    }
    return { flags, challenge: Buffer.from(message.subarray(24, 32)), targetInfo: flags & NEGOTIATE_TARGET_INFO ? Buffer.from(message.subarray(offset, offset + length)) : Buffer.alloc(0) }
}

/** One value of the target information's AV pairs, or null. */
function avPair (info: Buffer, id: number): Buffer | null {
    for (let at = 0; at + 4 <= info.length;) {
        const [pair, length] = [info.readUInt16LE(at), info.readUInt16LE(at + 2)]
        if (pair === AV_EOL) {
            break
        }
        if (pair === id) {
            return info.subarray(at + 4, at + 4 + length)
        }
        at += 4 + length
    }
    return null
}

/** What the client adds to the server's target information before sending it back. */
interface ClientInfo {
    /** An integrity code follows (the server said when it is). */
    mic: boolean
    /** What ties the sign-in to the TLS connection it is made over ("tls-server-end-point:" and the certificate's hash). */
    channelBinding?: Buffer
    /** The service signed in to (`HTTP/host`). */
    targetName?: string
}

function pair (id: number, value: Buffer): Buffer {
    const head = Buffer.alloc(4)
    head.writeUInt16LE(id, 0)
    head.writeUInt16LE(value.length, 2)
    return Buffer.concat([head, value])
}

/**
 * The channel binding's hash ([MS-NLMP] 3.1.5.1.2): MD5 over a gss_channel_bindings_struct with no addresses and the
 * binding as its application data.
 */
export function channelBindingHash (binding: Buffer): Buffer {
    const head = Buffer.alloc(20)
    head.writeUInt32LE(binding.length, 16)
    return createHash('md5').update(head).update(binding).digest()
}

/** The target information as the client's response carries it back: the server's pairs, and the client's own. */
function clientTargetInfo (info: Buffer, client: ClientInfo): Buffer {
    const pairs: Buffer[] = []
    let flags = client.mic ? AV_FLAG_MIC : 0
    for (let at = 0; at + 4 <= info.length;) {
        const [id, length] = [info.readUInt16LE(at), info.readUInt16LE(at + 2)]
        if (id === AV_EOL) {
            break
        }
        if (id === AV_FLAGS && length === 4) {
            flags |= info.readUInt32LE(at + 4)
        } else if (id !== AV_CHANNEL_BINDINGS && id !== AV_TARGET_NAME) {
            pairs.push(info.subarray(at, at + 4 + length))
        }
        at += 4 + length
    }
    if (flags) {
        const value = Buffer.alloc(4)
        value.writeUInt32LE(flags >>> 0)
        pairs.push(pair(AV_FLAGS, value))
    }
    // No binding to give: zeros, as Windows sends them (a server that insists on one refuses those).
    pairs.push(pair(AV_CHANNEL_BINDINGS, client.channelBinding ? channelBindingHash(client.channelBinding) : Buffer.alloc(16)))
    pairs.push(pair(AV_TARGET_NAME, utf16(client.targetName ?? '')))
    return Buffer.concat([...pairs, Buffer.alloc(4)])
}

/** Windows time (100 ns since 1601) of now. */
function now (): Buffer {
    const time = Buffer.alloc(8)
    time.writeBigUInt64LE((BigInt(Date.now()) + 11644473600000n) * 10000n)
    return time
}

/**
 * The NTLMv2 response to a challenge ([MS-NLMP] 3.3.2): the proof, with the blob it covers, and the session's base key.
 * `time` and `clientChallenge` are given by tests; otherwise the server's time (or now) and random bytes.
 */
export function ntlmV2Response (
    hash: Buffer, serverChallenge: Buffer, targetInfo: Buffer, time?: Buffer, clientChallenge: Buffer = randomBytes(8),
): { response: Buffer, sessionKey: Buffer } {
    const blob = Buffer.concat([
        Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), time ?? avPair(targetInfo, AV_TIMESTAMP) ?? now(), clientChallenge, Buffer.alloc(4), targetInfo, Buffer.alloc(4),
    ])
    const proof = hmacMd5(hash, serverChallenge, blob)
    return { response: Buffer.concat([proof, blob]), sessionKey: hmacMd5(hash, proof) }
}

/**
 * The third message: the answer to the server's challenge, for this account. `negotiate` and `challenge` are the two
 * messages before it, which its integrity code covers. `user@domain` and `DOMAIN\user` names carry their domain.
 * `channelBinding` and `targetName` say which TLS connection and which service the sign-in is for: servers set up
 * for extended protection (an RD Gateway, by default) refuse a sign-in without them.
 */
export function authenticateMessage (
    negotiate: Buffer, challenge: Buffer,
    account: { username: string, domain?: string, password: string, workstation?: string, channelBinding?: Buffer, targetName?: string },
): Buffer {
    const server = parseChallenge(challenge)
    const split = /^([^\\]+)\\(.+)$/.exec(account.username)
    const [domain, username] = split ? [split[1], split[2]] : [account.domain ?? '', account.username]
    // The server says when it is (a timestamp among its pairs) on every Windows since Vista: the response then
    // carries an integrity code, and the LM response is left empty.
    const timed = !!avPair(server.targetInfo, AV_TIMESTAMP)
    const targetInfo = server.targetInfo.length
        ? clientTargetInfo(server.targetInfo, { mic: timed, channelBinding: account.channelBinding, targetName: account.targetName })
        : server.targetInfo
    const hash = ntlmV2Hash(username, domain, account.password)
    const clientChallenge = randomBytes(8)
    const { response, sessionKey } = ntlmV2Response(hash, server.challenge, targetInfo, undefined, clientChallenge)
    const lm = timed ? Buffer.alloc(24) : Buffer.concat([hmacMd5(hash, server.challenge, clientChallenge), clientChallenge])
    const fields = [lm, response, utf16(domain), utf16(username), utf16(account.workstation ?? ''), Buffer.alloc(0)]
    // 64 bytes of fields and flags, 8 of version (none), 16 of integrity code, then what the fields point at.
    const header = Buffer.alloc(88)
    SIGNATURE.copy(header)
    header.writeUInt32LE(3, 8)
    let offset = header.length
    fields.forEach((field, i) => {
        header.writeUInt16LE(field.length, 12 + i * 8)
        header.writeUInt16LE(field.length, 14 + i * 8)
        header.writeUInt32LE(offset, 16 + i * 8)
        offset += field.length
    })
    const ours = NEGOTIATE_UNICODE | REQUEST_TARGET | NEGOTIATE_NTLM | NEGOTIATE_ALWAYS_SIGN | NEGOTIATE_EXTENDED_SESSIONSECURITY | NEGOTIATE_TARGET_INFO |
        NEGOTIATE_128 | NEGOTIATE_56
    header.writeUInt32LE((server.flags & ours & ~NEGOTIATE_VERSION) >>> 0, 60)
    const message = Buffer.concat([header, ...fields])
    if (timed) {
        hmacMd5(sessionKey, negotiate, challenge, message).copy(message, 72)
    }
    return message
}
