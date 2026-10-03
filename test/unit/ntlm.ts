// NTLMv2 for the RD Gateway's sign-in (src/ntlm.ts), against the published vectors: MD4's (RFC 1320) and the
// protocol's own ([MS-NLMP] 4.2.4). Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHmac } from 'node:crypto'

const require = createRequire(import.meta.url)
const { md4, ntlmV2Hash, ntlmV2Response, negotiateMessage, parseChallenge, authenticateMessage, channelBindingHash } = require('../../dist/ntlm.js')

const hex = (b: Buffer) => b.toString('hex')

test('MD4: the RFC\'s test suite', () => {
    const vectors: Record<string, string> = {
        '': '31d6cfe0d16ae931b73c59d7e0c089c0',
        a: 'bde52cb31de33e46245e05fbdbd6fb24',
        abc: 'a448017aaf21d8525fc10ae87aa6729d',
        'message digest': 'd9130a8164549fe818874806e1c7014b',
        abcdefghijklmnopqrstuvwxyz: 'd79e1c308aa5bbcdeea8ed63df412da9',
        ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789: '043f8582f241db351ce627e153e7f0e4',
        '12345678901234567890123456789012345678901234567890123456789012345678901234567890': 'e33b4ddc9c38f2199c3e7b164fcc0536',
    }
    for (const [text, digest] of Object.entries(vectors)) {
        assert.equal(hex(md4(Buffer.from(text))), digest, JSON.stringify(text))
    }
})

// [MS-NLMP] 4.2.1 and 4.2.4: User, Domain, Password; the server's challenge and target information; a client
// challenge of aa…; time zero.
const SERVER_CHALLENGE = Buffer.from('0123456789abcdef', 'hex')
const TARGET_INFO = Buffer.from('02000c0044006f006d00610069006e0001000c005300650072007600650072000000' + '0000', 'hex')

test('NTLMv2: the protocol document\'s hash, proof and session key', () => {
    assert.equal(hex(md4(Buffer.from('Password', 'utf16le'))), 'a4f49c406510bdcab6824ee7c30fd852')
    const hash = ntlmV2Hash('User', 'Domain', 'Password')
    assert.equal(hex(hash), '0c868a403bfd7a93a3001ef22ef02e3f')
    const { response, sessionKey } = ntlmV2Response(hash, SERVER_CHALLENGE, TARGET_INFO, Buffer.alloc(8), Buffer.alloc(8, 0xaa))
    assert.equal(hex(response.subarray(0, 16)), '68cd0ab851e51c96aabc927bebef6a1c')
    assert.equal(hex(sessionKey), '8de40ccadbc14a82f15cb0ad0de95ca3')
})

/** A challenge message with these flags and this target information. */
function challengeMessage (flags: number, targetInfo: Buffer): Buffer {
    const message = Buffer.alloc(56)
    message.write('NTLMSSP\0', 'latin1')
    message.writeUInt32LE(2, 8)
    message.writeUInt32LE(56, 16)
    message.writeUInt32LE(flags >>> 0, 20)
    SERVER_CHALLENGE.copy(message, 24)
    message.writeUInt16LE(targetInfo.length, 40)
    message.writeUInt16LE(targetInfo.length, 42)
    message.writeUInt32LE(56, 44)
    return Buffer.concat([message, targetInfo])
}

test('the three messages: fields where they say they are, the proof and the integrity code verifiable', () => {
    const negotiate: Buffer = negotiateMessage()
    assert.equal(negotiate.subarray(0, 8).toString('latin1'), 'NTLMSSP\0')
    assert.equal(negotiate.readUInt32LE(8), 1)
    // A server that says when it is, as Windows does: a timestamp among the target information's pairs.
    const time = Buffer.from('0090d336b734c301', 'hex')
    const info = Buffer.concat([TARGET_INFO.subarray(0, TARGET_INFO.length - 4), Buffer.from('07000800', 'hex'), time, Buffer.alloc(4)])
    const challenge = challengeMessage(0xe28a8215, info)
    assert.equal(hex(parseChallenge(challenge).challenge), hex(SERVER_CHALLENGE))
    const message: Buffer = authenticateMessage(negotiate, challenge, { username: 'DOMAIN\\User', password: 'Password', workstation: 'HERE' })
    assert.equal(message.readUInt32LE(8), 3)
    const field = (i: number) => message.subarray(message.readUInt32LE(16 + i * 8), message.readUInt32LE(16 + i * 8) + message.readUInt16LE(12 + i * 8))
    assert.equal(hex(field(0)), '00'.repeat(24))                       // no LM response next to a timestamp
    assert.equal(field(2).toString('utf16le'), 'DOMAIN')
    assert.equal(field(3).toString('utf16le'), 'User')
    assert.equal(field(4).toString('utf16le'), 'HERE')
    // The NT response: a proof over the server's challenge and the blob, by the account's hash.
    const nt = field(1)
    const hash = ntlmV2Hash('User', 'DOMAIN', 'Password')
    const proof = createHmac('md5', hash).update(SERVER_CHALLENGE).update(nt.subarray(16)).digest()
    assert.equal(hex(nt.subarray(0, 16)), hex(proof))
    assert.equal(hex(nt.subarray(24, 32)), hex(time))                  // the server's time, as given
    assert.ok(nt.includes(Buffer.from('0600040002000000', 'hex')))     // "an integrity code follows"
    // No TLS connection to bind to: zeros for the channel binding, and an empty target name.
    assert.ok(nt.includes(Buffer.concat([Buffer.from('0a001000', 'hex'), Buffer.alloc(16), Buffer.from('09000000', 'hex'), Buffer.alloc(4)])))
    const bound: Buffer = authenticateMessage(negotiate, challenge, { username: 'User', password: 'Password', channelBinding: Buffer.from('tls-server-end-point:abc'), targetName: 'HTTP/gw' })
    assert.ok(bound.includes(Buffer.concat([Buffer.from('0a001000', 'hex'), channelBindingHash(Buffer.from('tls-server-end-point:abc')), Buffer.from('09000e00', 'hex'), Buffer.from('HTTP/gw', 'utf16le'), Buffer.alloc(4)])))
    // The integrity code: over all three messages, with its own place zeroed, by the session key.
    const zeroed = Buffer.from(message)
    zeroed.fill(0, 72, 88)
    const key = createHmac('md5', hash).update(proof).digest()
    assert.equal(hex(message.subarray(72, 88)), hex(createHmac('md5', key).update(negotiate).update(challenge).update(zeroed).digest()))
    // A wrong password gives another proof.
    const other: Buffer = authenticateMessage(negotiate, challenge, { username: 'User', domain: 'DOMAIN', password: 'password' })
    assert.notEqual(hex(other.subarray(other.readUInt32LE(24), other.readUInt32LE(24) + 16)), hex(proof))
})

test('a challenge that isn\'t one is refused', () => {
    assert.throws(() => parseChallenge(Buffer.from('nonsense')), /not an NTLM challenge/)
    assert.throws(() => authenticateMessage(negotiateMessage(), negotiateMessage(), { username: 'u', password: 'p' }), /not an NTLM challenge/)
})
