// RDCleanPath proxy for the IronRDP web client. The proxy itself runs in the plugin's network helper (helper/, a
// process of its own, see proxyHelper.ts): the WASM client talks WebSocket to it; it opens the upstream stream (a
// TCP connection of its own, a stream carried from here over an SSH channel, or a tunnel through an RD Gateway),
// forwards the X.224 request, terminates TLS, has this side decide on the server's certificate, hands the cert chain
// back to the client (for CredSSP), then relays. What is decided stays here: the certificate, a server without
// Network Level Authentication, the gateway's account; and so does the room for answers (ServerFlow).
import { createHash } from 'crypto'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { Duplex } from 'stream'
import * as tls from 'tls'
import { authoritiesPem, CertificateDetails, certificateDetails, peerCertificate, validity } from './authorities'
import type { GatewayAccount } from './gateway'
import { CodedError, describeExit, Helper } from './proxyHelper'

/** A server reached with a TCP connection from this computer (LAN, VPN): the helper connects, to its name as resolved here. */
export interface DirectUpstream {
    direct: { host: string, port: number }
}

/**
 * A desktop behind an RD Gateway ([MS-TSGU], its WebSocket transport, signed in to with NTLM: helper/internal/gateway),
 * and the way to the gateway: a stream opened here (through an SSH host), or a TCP connection from this computer.
 */
export interface GatewayUpstream {
    gateway: { host: string, port: number }
    target: { host: string, port: number }
    via: (() => Promise<Duplex>) | DirectUpstream
    /** A name for this computer, as the gateway's logs will have it. */
    clientName?: string
    /** For each step of setting the tunnel up (default 20 s). */
    timeoutMs?: number
    /**
     * Decides on the gateway's certificate before the account is used, as CertificateCheck does on a server's:
     * whether it is valid for the gateway's name by this computer's certificate authorities; throws to refuse.
     */
    checkCertificate: CertificateCheck
    /** The account to sign in with, asked for only once the certificate is accepted. */
    account: () => GatewayAccount | Promise<GatewayAccount>
    /** The gateway refused the account (its sign-in, or its connection authorization policy): its words. */
    refused?: (message: string) => void
    /** The tunnel is up: the gateway took the account. */
    opened?: () => void
}

/** Where a connection's server is, and how it is reached (see UpstreamFactory). */
export type Upstream = Duplex | DirectUpstream | GatewayUpstream

/**
 * Says how to reach the server at `destination`: a stream opened here (an SSH channel, say), which the helper's
 * connection runs over, a TCP connection the helper makes, or a gateway. `signal` aborts once the client it is for has
 * gone (see the connection's end), so that what takes time to open one can stop rather than go on, for no one.
 */
export type UpstreamFactory = (destination: string, signal?: AbortSignal) => Promise<Upstream>

/**
 * Decides on the server's certificate, given its SHA-256 fingerprint (`AB:CD:…`), whether it is valid for the
 * server's name by this computer's certificate authorities (see RDCleanPathOptions.serverName), why not (OpenSSL's
 * code for it, as Node reported it, such as DEPTH_ZERO_SELF_SIGNED_CERT; '' when it is), and what the certificate says
 * of itself (whom it was issued to and by, and its dates; see CertificateDetails); throws to refuse it. Upstream TLS
 * accepts any certificate (RDP servers make their own), so this is what stands between the client and an impostor. It
 * runs before the client hears back from the proxy, and so before CredSSP: no credentials have been sent yet, nor the
 * user name (the proxy takes it out of the connection request).
 */
export type CertificateCheck = (fingerprint: string, valid: boolean, reason: string, details?: CertificateDetails) => void | Promise<void>

/** A SHA-256 fingerprint as `AB:CD:…` (openssl and Node print it so), from any hex spelling; '' if it isn't one. */
export function normalizeFingerprint (value: string): string {
    const hex = String(value ?? '').replace(/[\s:]/g, '').toUpperCase()
    return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g)!.join(':') : ''
}

function fingerprintOf (der: Buffer): string {
    return normalizeFingerprint(createHash('sha256').update(der).digest('hex'))
}

export interface RDCleanPathProxy extends ServerFlow {
    /** Where the client connects: the token is its path (and goes in its request too). */
    url: string
    token: string
    /**
     * Why the last connection failed before the relay was up (the server didn't answer, refused, offered no TLS, sent
     * no certificate): the client only sees a generic RDCleanPath error then. Or why the proxy ended the relay (see
     * SERVER_BACKLOG), or why the helper stopped.
     */
    failure: string | null
    /** RDP bytes relayed since the proxy started (after TLS, before SSH): from the server, and to it. */
    stats: { bytesIn: number, bytesOut: number }
    /** What the proxy has read from the connection and the server hasn't taken yet: it waits in the proxy (see send). */
    readonly backlog: number
    /** The helper has stopped (closed, or failed): nothing more connects here, and a desktop needs a new proxy. */
    readonly ended: boolean
    /** Resolves once the helper has stopped, its port closed and its connections ended (see close). */
    readonly stopped: Promise<void>
    /**
     * Stops the proxy: nothing more goes to the server, the streams carried for it end at once, and the helper stops
     * listening and ends its connections as soon as it hears (see stopped).
     */
    close (): void
}

/**
 * Room for what answers the remote desktop's requests with far more than they are: a part of a file sent from here
 * (FileTransfer), a shared folder's read (SharedDrives). What is handed to the connection goes to the server as the
 * proxy reads it from the connection's WebSocket, and waits until the server takes it: first in the connection, until
 * the proxy reads it (at once: the proxy reads whatever the server does), then in the proxy (its backlog). A server
 * that keeps asking and reads slowly, or not at all, could have those answers fill memory, so each takes room before
 * it is read for the remote, and waits while there is none. The room is FLOW_WINDOW less what was taken and the proxy
 * hasn't read from the connection since, and less the backlog: whatever waits for the server counts, the connection's
 * other messages too. Room is taken while there is any, so what is taken can pass FLOW_WINDOW by one answer; what an
 * answer didn't use (a short read, an error, none at all) is given back. Only answers wait for room: everything else
 * the connection sends (input, the clipboard's answers, sound) goes to the proxy as it is, and is bounded there alone,
 * by SERVER_BACKLOG, past which the connection ends. RDCleanPathProxy gives the room, for the connection it relays.
 *
 * The proxy runs in the network helper: it reports what it read from the connection and what waits for the server a
 * few milliseconds after they change, and the room here goes by the latest report. SERVER_BACKLOG it holds to itself,
 * exactly.
 */
export interface ServerFlow {
    /** Whether there is room now. */
    room (): boolean
    /** Takes `bytes` of room, for an answer about to be read for the remote and handed to the connection. */
    spend (bytes: number): void
    /** Gives back `bytes` taken and not handed to the connection after all. */
    refund (bytes: number): void
    /** Resolves once there is room (at once if there is), or the connection ends. */
    whenRoom (): Promise<void>
}

/**
 * What answers to the remote's requests may have taken of memory, read for it, handed to the connection or waiting in
 * the proxy for the server (see ServerFlow): four of the largest parts of files a request gets.
 */
export const FLOW_WINDOW = 64 * 1024 * 1024

/** A WebSocket message from the client: RDP PDUs, at most a few megabytes for a shared drive's read. */
const MAX_MESSAGE = 32 * 1024 * 1024
/** Data waiting for the client past this pauses the server, until half of it is gone. */
const HIGH_WATER = 8 * 1024 * 1024
/**
 * What may wait in the proxy for a server that doesn't take it, before the connection ends (the helper's
 * ServerBacklog). Answers keep within FLOW_WINDOW of it and one message more (see ServerFlow), so the rest of what the
 * client sends (input, sound, and the clipboard's answers, which nothing else bounds) always has HIGH_WATER at least.
 */
export const SERVER_BACKLOG = FLOW_WINDOW + MAX_MESSAGE + HIGH_WATER

export interface RDCleanPathOptions {
    /** Set INFO_AUTOLOGON in the client's Client Info PDU (xrdp, whose own login window shows otherwise). */
    autologon?: boolean
    /**
     * Called when the server chose TLS without Network Level Authentication, before anything more is sent to it: the
     * client would go on to send the password as it is. Throws to refuse. Not optional, so that no caller lets such
     * servers through by leaving it out; without options at all, they are refused (refuseWithoutNla).
     */
    withoutNla: () => void | Promise<void>
    /**
     * Called for a server that withoutNla let through, once the certificate check has taken its certificate: that
     * certificate's fingerprint, before the client hears back and so before the password goes to it. Throws to stop
     * there. withoutNla decides before TLS, with no certificate to go by; this holds what it decided to the server that
     * then showed one (a permission given for one certificate isn't one for another). Left out, nothing is held to a
     * certificate: a caller whose withoutNla lets a server through on a permission it remembered (as the desktop
     * service's does) has to give this, or that permission goes to whatever answers there next.
     */
    withoutNlaCertificate?: (fingerprint: string) => void | Promise<void>
    /**
     * The name the server goes by here (a host name, or an IP address): its certificate is checked against it and
     * this computer's certificate authorities, for the certificate check to weigh, and a host name goes in the TLS
     * handshake (SNI) as other clients send it. Without one, nothing is checked that way, and the certificate is never
     * taken for valid: the desktops reached through an SSH host, whose names are that host's.
     */
    serverName?: string
    /** The certificate authorities certificates are checked against, in place of this computer's (tests: their own). */
    tls?: { ca?: tls.SecureContextOptions['ca'] }
    /** How long reaching the server, TLS included, may take before the connection is given up on (tests: less). */
    handshakeTimeoutMs?: number
    /** Optional PDU trace input: raw relay bytes, plus the X.224 request and response. */
    tap?: (direction: 'in' | 'out', data: Buffer, kind?: 'x224') => void
}

/** The answer to a server without Network Level Authentication where nobody decides otherwise: refused. */
function refuseWithoutNla (): never {
    throw new Error('the server doesn\'t use Network Level Authentication')
}

/**
 * `text` without the proxy's token. IronRDP's error for an address it couldn't connect to names the address, whose path
 * is the token, and such an error goes to the desktop's status line and its log, which "Copy log" hands out.
 */
export function withoutToken (text: string, proxy: { token: string } | null | undefined): string {
    return proxy?.token ? text.split(proxy.token).join('…') : text
}

function isDirect (upstream: unknown): upstream is DirectUpstream {
    return !!upstream && typeof upstream === 'object' && !(upstream instanceof Duplex) && !!(upstream as DirectUpstream).direct
}

function isGateway (upstream: unknown): upstream is GatewayUpstream {
    return !!upstream && typeof upstream === 'object' && !(upstream instanceof Duplex) && !!(upstream as GatewayUpstream).gateway && !!(upstream as GatewayUpstream).target
}

/**
 * A server's addresses as this computer's resolver gives them (the hosts file, mDNS, a VPN's DNS), as Node's own
 * connections had them, with the label its failures name it by.
 */
async function resolved (host: string, port: number): Promise<{ kind: 'direct', host: string, port: number, label: string, addresses: string[] }> {
    const label = `${host.includes(':') ? `[${host}]` : host}:${port}`
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map(a => a.address)
    return { kind: 'direct', host, port, label, addresses }
}

/** One of the helper's connections, as far as this side keeps it. */
interface Connection {
    leaving: AbortController
    gateway?: GatewayUpstream
}

export async function startRDCleanPathProxy (openUpstream: UpstreamFactory, checkCertificate: CertificateCheck, log: (msg: string) => void = () => {}, options: RDCleanPathOptions = { withoutNla: refuseWithoutNla }): Promise<RDCleanPathProxy> {
    // Called from JavaScript without the decision, the proxy still refuses such servers rather than let them through.
    if (typeof options.withoutNla !== 'function') {
        options = { ...options, withoutNla: refuseWithoutNla }
    }
    const authorities = options.tls?.ca
    const helper = await Helper.start()
    let failure: string | null = null
    const stats = { bytesIn: 0, bytesOut: 0 }
    // The room (see ServerFlow): what was taken for answers and not read from the connection since, what waits for
    // the server as last reported, and what waits for room. Once the proxy is closed there is room for good: nothing
    // more goes anywhere.
    let owed = 0
    let backlog = 0
    let roomWaiters: (() => void)[] = []
    let shut = false
    const hasRoom = () => shut || owed + backlog < FLOW_WINDOW
    const roomMade = () => {
        if (roomWaiters.length && hasRoom()) {
            const go = roomWaiters
            roomWaiters = []
            go.forEach(f => f())
        }
    }
    let closed = false
    const connections = new Map<number, Connection>()
    const connection = (id: number) => {
        let c = connections.get(id)
        if (!c) {
            c = { leaving: new AbortController() }
            connections.set(id, c)
        }
        return c
    }

    // An event's fields as the helper has to send them; one that doesn't stops the helper (see Helper.onEvent),
    // rather than leaving a connection unknown or the room a NaN that never makes room again.
    const conn = (body: any): number => {
        if (!Number.isSafeInteger(body?.conn) || body.conn < 0) {
            throw new Error('no connection number')
        }
        return body.conn
    }
    const count = (value: unknown, otherwise: number): number => {
        if (value === undefined) {
            return otherwise
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new Error(`a count of ${String(value)}`)
        }
        return value
    }
    helper.onEvent = (event, body, blobs) => {
        switch (event) {
            case 'log':
                log(String(body?.message ?? ''))
                break
            case 'accepted':
                failure = null
                connection(conn(body))
                break
            case 'closed': {
                // The client has gone: what is still being opened for it stops.
                const id = conn(body)
                connections.get(id)?.leaving.abort()
                connections.delete(id)
                break
            }
            case 'gatewayOpened':
                connections.get(conn(body))?.gateway?.opened?.()
                break
            case 'flow': {
                // All of it read before any is taken, so that a report with one bad count changes nothing.
                const read = count(body?.read, 0)
                const waiting = count(body?.backlog, 0)
                const bytesIn = count(body?.bytesIn, stats.bytesIn)
                const bytesOut = count(body?.bytesOut, stats.bytesOut)
                // What was handed to a connection that ended (or was replaced) went with it: the next starts with all
                // the room. What the proxy read from the connection is no longer waiting there.
                if (body?.reset) {
                    owed = 0
                }
                owed = Math.max(0, owed - read)
                backlog = waiting
                stats.bytesIn = bytesIn
                stats.bytesOut = bytesOut
                roomMade()
                break
            }
            case 'tap': {
                if (!options.tap) { break }
                if ((body?.direction !== 'in' && body?.direction !== 'out') ||
                    (body?.kind !== '' && body.kind !== 'x224') || blobs.length !== 1) {
                    throw new Error('malformed PDU trace event')
                }
                try { options.tap(body.direction, blobs[0], body.kind === 'x224' ? 'x224' : undefined) } catch (e: any) { log(`trace: ${e?.message ?? e}`) }
                break
            }
        }
    }

    // Open one (see open): what a connection's requests share; past its end, nothing is kept for it.
    const of = (id: number) => connections.get(id) ?? { leaving: new AbortController() }
    const open = async (c: Connection, destination: string, stream: number) => {
        const upstream = await openUpstream(destination, c.leaving.signal)
        if (isDirect(upstream)) {
            return { body: await resolved(upstream.direct.host, upstream.direct.port) }
        }
        if (isGateway(upstream)) {
            c.gateway = upstream
            let via: object
            if (isDirect(upstream.via)) {
                via = await resolved(upstream.via.direct.host, upstream.via.direct.port)
            } else {
                if (c.leaving.signal.aborted) {
                    throw new Error('the desktop was closed meanwhile')
                }
                helper.bridge(stream, await upstream.via())
                via = { kind: 'stream' }
            }
            return {
                body: {
                    kind: 'gateway', gateway: upstream.gateway, target: upstream.target, clientName: upstream.clientName ?? 'tabby-rdp',
                    timeoutMs: upstream.timeoutMs ?? 20000, via,
                },
            }
        }
        helper.bridge(stream, upstream)
        return { body: { kind: 'stream' } }
    }

    helper.onRequest = async (method, body, blobs) => {
        const c = of(body.conn)
        switch (method) {
            case 'open': {
                // The helper numbered the stream it would run over; one not opened (another way, a failure) is let go.
                helper.expect(body.stream)
                try {
                    return await open(connection(body.conn), String(body.destination), body.stream)
                } finally {
                    helper.unused(body.stream)
                }
            }
            case 'withoutNla':
                await options.withoutNla()
                return
            case 'certificate': {
                // The chain as the server sent it (DER), and the helper's verdict on it; the name is checked here.
                const gateway = body.scope === 'gateway' ? c.gateway : undefined
                const name = body.scope === 'gateway' ? gateway?.gateway.host : options.serverName
                const peer = peerCertificate(blobs, authorities)
                const { valid, reason } = validity(name, !!body.chainOk, String(body.reason ?? ''), peer)
                // Where the chain stands and whether it is for the name, which the reason it isn't valid can hide (see
                // certificateDetails), by the authorities it was checked against.
                const details = certificateDetails(peer, name && !valid ? { name, authorities: authorities ?? undefined, reason } : undefined)
                const fingerprint = fingerprintOf(blobs[0])
                if (body.scope === 'gateway') {
                    if (!gateway) {
                        throw new Error('the gateway\'s certificate came for no gateway')
                    }
                    await gateway.checkCertificate(fingerprint, valid, reason, details)
                    return
                }
                await checkCertificate(fingerprint, valid, reason, details)
                // A server without NLA, let through before TLS: what let it through is held to its certificate.
                if (body.nla === false && options.withoutNlaCertificate) {
                    await options.withoutNlaCertificate(fingerprint)
                }
                return
            }
            case 'gatewayAccount': {
                if (!c.gateway) {
                    throw new Error('an account was asked for no gateway')
                }
                // The account goes only to a connection still wanted: not once the desktop has closed or its client
                // has gone, which the sign-in (a prompt, say) may have taken long enough for.
                const gone = () => closed || c.leaving.signal.aborted
                if (gone()) {
                    throw new Error('the desktop was closed meanwhile')
                }
                const account = await c.gateway.account()
                if (gone()) {
                    throw new Error('the desktop was closed meanwhile')
                }
                return { body: { username: account.username, domain: account.domain ?? '', password: account.password } }
            }
            case 'failure': {
                failure = String(body.message ?? '')
                if (body.signIn) {
                    c.gateway?.refused?.(failure)
                }
                log(body.stage === 'relay' ? `RDCleanPath relay ended: ${failure}` : `RDCleanPath failed: ${failure}`)
                return
            }
        }
        throw new CodedError(`unknown method ${method}`, 'unknown')
    }

    helper.exited.then(exit => {
        if (!exit.expected) {
            failure = `the network helper stopped unexpectedly (${describeExit(exit)})`
            log(failure)
        }
        for (const c of connections.values()) {
            c.leaving.abort()
        }
        connections.clear()
        shut = true
        owed = 0
        roomMade()
    })

    let started: { body: any }
    try {
        started = await helper.request('start', {
            autologon: !!options.autologon,
            serverName: options.serverName ?? '',
            handshakeTimeoutMs: options.handshakeTimeoutMs ?? 0,
            trace: !!options.tap,
        }, [Buffer.from(authoritiesPem(authorities))])
    } catch (e) {
        helper.kill()
        throw e
    }
    const token = String(started.body.token)
    return {
        url: `ws://127.0.0.1:${Number(started.body.port)}/${token}`,
        token,
        stats,
        get failure () { return failure },
        get backlog () { return backlog },
        get ended () { return closed || helper.ended },
        stopped: helper.exited.then(() => undefined),
        close: () => {
            if (closed) {
                return
            }
            closed = true
            // What is still being opened or asked for stops now, not once the helper has gone.
            for (const c of connections.values()) {
                c.leaving.abort()
            }
            // Nothing more goes to the server: what waited for room goes on, and finds the end.
            shut = true
            owed = 0
            roomMade()
            helper.close()
        },
        room: hasRoom,
        // Counted only as a number of bytes: anything else would leave the room unknown, and every answer waiting.
        spend: (bytes: number) => {
            if (bytes > 0) {
                owed += bytes
            }
        },
        refund: (bytes: number) => {
            if (bytes > 0) {
                owed = Math.max(0, owed - bytes)
                roomMade()
            }
        },
        whenRoom: () => hasRoom() ? Promise.resolve() : new Promise<void>(resolve => roomWaiters.push(resolve)),
    }
}
