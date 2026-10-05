// The shared folders' file system (src/drives.ts, SharedDrives): what IronRDP's drive backend calls with the
// server's paths. Runs against the built plugin: npm run build && npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { SharedDrives, sharedFolders, driveName, MAX_OPEN_FILES, WINDOW_OPEN_FILES, openFilesInWindow } = require('../../dist/drives.js')
import { Link } from './support/link.js'
/** The `fs` the plugin uses (fs.promises included), whose functions it looks up on each call: to stand in for disks. */
const nodeFs = require('fs')

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString()
const bytes = (s: string) => new Uint8Array(Buffer.from(s))
const open = (write = false) => ({ write, create: write, exclusive: false, truncate: false })
const code = async (f: () => unknown) => {
    try {
        await f()
    } catch (e: any) {
        return e.code
    }
    return 'ok'
}

/** Lets what is under way run until `done` (files are closed on Node's thread pool), for ten seconds at most. */
async function until (done: () => boolean): Promise<void> {
    for (const end = Date.now() + 10000; !done() && Date.now() < end;) {
        await new Promise(resolve => setImmediate(resolve))
    }
    assert.ok(done(), 'still waiting')
}

/** The folders the tests made, removed when they are done. */
const made: string[] = []
after(() => made.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

function sandbox (): { dir: string, other: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-drive-'))
    made.push(dir)
    fs.mkdirSync(path.join(dir, 'share', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'share', 'hello.txt'), 'hello')
    fs.writeFileSync(path.join(dir, 'share', 'sub', 'deep.txt'), 'deep')
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside')
    return { dir: path.join(dir, 'share'), other: dir }
}

test('paths are the drive\'s: backslashes, the root, and nothing outside the folder', async () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    assert.deepEqual(drives.drives, [{ id: 1, name: 'Share' }])
    assert.equal((await drives.stat(1, '\\')).dir, true)
    assert.equal((await drives.stat(1, '\\hello.txt')).size, 5)
    assert.equal((await drives.stat(1, 'sub/deep.txt')).size, 4)
    assert.equal(await drives.stat(1, '\\missing.txt'), null)
    assert.deepEqual((await drives.list(1, '\\')).sort(), ['hello.txt', 'sub'])
    // The folder above holds secret.txt: not reachable, however the path is spelled.
    for (const escape of ['\\..\\secret.txt', '..\\secret.txt', '\\sub\\..\\..\\secret.txt', '/../secret.txt']) {
        assert.equal(await drives.stat(1, escape), null, escape)
        assert.equal(await code(() => drives.open(1, escape, open())), 'ENOENT', escape)
    }
    assert.equal(await drives.stat(2, '\\'), null)
    assert.equal(await code(() => drives.list(2, '\\')), 'ENOENT')
})

test('a read waits while the connection has no room, takes room for what it reads, and gives back what it didn\'t read', async () => {
    const { dir } = sandbox()
    // The desktop's proxy on its server (see ServerFlow): what was handed to the connection, and isn't read from it
    // yet, has taken all the room, as when the server leaves what is sent unread.
    let owed = 64
    let made = () => { }
    const flow = {
        room: () => owed < 64,
        spend: (bytes: number) => { owed += bytes },
        refund: (bytes: number) => { owed -= bytes },
        whenRoom: () => owed < 64 ? Promise.resolve() : new Promise<void>(resolve => { made = resolve }),
    }
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }], () => null, flow)
    const h = await drives.open(1, '\\hello.txt', open())
    let answered = false
    const read = drives.read(h, 0, 100).then((data: Uint8Array) => { answered = true; return data })
    for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(answered, false)
    owed = 0
    made()
    assert.equal(text(await read), 'hello')
    // It took room for the hundred bytes asked for, and gave back the 95 the file didn't have.
    assert.equal(owed, 5)
    // While there is room, at once; a read that fails takes none.
    assert.equal(text(await drives.read(h, 1, 2)), 'el')
    assert.equal(owed, 7)
    await drives.close(h)
    assert.equal(await code(() => drives.read(h, 0, 100)), 'EBADF')
    assert.equal(owed, 7)
})

/** The most a read gets (READ_LIMIT). */
const READ = 4 * 1024 * 1024

/**
 * Reads `file` from the share, a read at a time, each answer handed to the connection (`link`), from `start` on and
 * round again, until told to stop: what it read, in order.
 */
function copying (drives: any, h: number, link: Link, size: number) {
    let stop = false
    const parts: Uint8Array[] = []
    const done = (async () => {
        for (let at = 0; !stop; at = (at + READ) % size) {
            const data: Uint8Array = await drives.read(h, at, READ)
            link.hand(data.length)
            parts.push(data)
        }
    })()
    return { parts, stop: () => { stop = true; return done } }
}

/** Lets the server read whatever the proxy sends it (see Link) until `done` settles. */
async function drained (link: Link, done: Promise<unknown>): Promise<void> {
    let settled = false
    done.then(() => { settled = true }, () => { settled = true })
    while (!settled) {
        link.tick(Infinity)
        await new Promise(resolve => setImmediate(resolve))
    }
    await done
}

test('what a shared folder\'s reads hand to the connection stays within the room it gives, however slowly the server reads', async () => {
    const { dir } = sandbox()
    fs.writeFileSync(path.join(dir, 'video.mp4'), Buffer.alloc(64 * MB, 1))
    // A server that reads 2 MB at a time, now and then, behind the proxy (see Link), and a room of 64 MB. The proxy
    // takes 64 KB in a turn, as a socket's read does: a drive's read of 4 MB is far quicker to hand over.
    const link = new Link(64 * MB, 8 * MB, 64 * 1024)
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }], () => null, link)
    try {
        const h = await drives.open(1, '\\video.mp4', open())
        const copy = copying(drives, h, link, 64 * MB)
        // As long as the disk takes (a slow one, a busy machine), 20 seconds at most.
        for (const end = performance.now() + 20000; link.serverRead < 50 * MB && link.most <= 64 * MB + READ && performance.now() < end;) {
            for (let i = 0; i < 20; i++) {
                await new Promise(resolve => setImmediate(resolve))
            }
            link.tick(2 * MB)
        }
        assert.ok(link.most <= 64 * MB + READ, `${link.most / MB} MB handed to the connection and not read`)
        assert.ok(link.serverRead >= 50 * MB, `the server read ${link.serverRead / MB} MB`)
        // The server reads all of it: the copy finishes its read, and stops.
        await drained(link, copy.stop())
        await drives.close(h)
    } finally {
        // Whatever happened: the window's count of open files is the next test's too.
        drives.dispose()
    }
})

test('a shared folder\'s file copied over a slow link arrives whole, the room spent again and again', async () => {
    const { dir } = sandbox()
    const bytes = Buffer.alloc(24 * MB)
    for (let i = 0; i < bytes.length; i += 4096) {
        bytes.writeUInt32LE(i, i)
    }
    fs.writeFileSync(path.join(dir, 'big.bin'), bytes)
    // Room for 8 MB, a link that takes 1 MB at a time.
    const link = new Link(8 * MB, 2 * MB, 64 * 1024)
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }], () => null, link)
    const h = await drives.open(1, '\\big.bin', open())
    const copy = copying(drives, h, link, 24 * MB)
    let waits = 0
    for (let round = 0; round < 1000 && copy.parts.length < 6; round++) {
        for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setImmediate(resolve))
        }
        waits += link.room() ? 0 : 1
        link.tick(MB)
    }
    await drained(link, copy.stop())
    assert.ok(waits > 0, 'the reads waited for room')
    assert.ok(Buffer.concat(copy.parts.slice(0, 6)).equals(bytes))
    await drives.close(h)
})

test('files read and write at offsets, through handles', async () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    const h = await drives.open(1, '\\hello.txt', open())
    assert.equal(text(await drives.read(h, 0, 100)), 'hello')
    assert.equal(text(await drives.read(h, 1, 2)), 'el')
    assert.equal((await drives.read(h, 5, 10)).length, 0)
    assert.equal(await code(() => drives.write(h, 0, bytes('x'))), 'EBADF')  // opened for reading
    await drives.close(h)
    const w = await drives.open(1, '\\new.txt', { write: true, create: true, exclusive: true, truncate: false })
    assert.equal(await drives.write(w, 0, bytes('abcdef')), 6)
    assert.equal(await drives.write(w, 2, bytes('XY')), 2)
    await drives.truncate(w, 5)
    await drives.close(w)
    assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'abXYe')
    assert.equal(await code(() => drives.open(1, '\\new.txt', { write: true, create: true, exclusive: true, truncate: false })), 'EEXIST')
    assert.equal(await code(() => drives.read(w, 0, 1)), 'EBADF')  // closed
})

test('folders are made, renamed and removed; a rename replaces only when told to', async () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    await drives.mkdir(1, '\\made')
    assert.equal((await drives.stat(1, '\\made')).dir, true)
    assert.equal(await code(() => drives.mkdir(1, '\\made')), 'EEXIST')
    assert.equal(await code(() => drives.remove(1, '\\sub')), 'ENOTEMPTY')
    await drives.rename(1, '\\hello.txt', '\\made\\moved.txt', false)
    assert.equal(fs.readFileSync(path.join(dir, 'made', 'moved.txt'), 'utf8'), 'hello')
    assert.equal(await code(() => drives.rename(1, '\\sub\\deep.txt', '\\made\\moved.txt', false)), 'EEXIST')
    await drives.rename(1, '\\sub\\deep.txt', '\\made\\moved.txt', true)
    assert.equal(fs.readFileSync(path.join(dir, 'made', 'moved.txt'), 'utf8'), 'deep')
    // The same file under another spelling (case-insensitive file systems see it as existing).
    await drives.rename(1, '\\made\\moved.txt', '\\made\\MOVED.txt', false)
    assert.ok(fs.readdirSync(path.join(dir, 'made')).includes('MOVED.txt'))
    await drives.remove(1, '\\made\\MOVED.txt')
    await drives.remove(1, '\\made')
    await drives.remove(1, '\\sub')
    assert.deepEqual(await drives.list(1, '\\'), [])
    assert.equal(await code(() => drives.remove(1, '\\')), 'EACCES')  // the shared folder itself
    assert.ok(fs.existsSync(dir))
})

test('a read-only folder refuses every change and reports its files read-only', async () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }])
    assert.equal((await drives.stat(1, '\\hello.txt')).readonly, true)
    const h = await drives.open(1, '\\hello.txt', open())
    assert.equal(text(await drives.read(h, 0, 5)), 'hello')
    await drives.close(h)
    assert.equal(await code(() => drives.open(1, '\\hello.txt', open(true))), 'EACCES')
    assert.equal(await code(() => drives.open(1, '\\new.txt', { write: false, create: true, exclusive: false, truncate: false })), 'EACCES')
    assert.equal(await code(() => drives.mkdir(1, '\\made')), 'EACCES')
    assert.equal(await code(() => drives.remove(1, '\\hello.txt')), 'EACCES')
    assert.equal(await code(() => drives.rename(1, '\\hello.txt', '\\bye.txt', false)), 'EACCES')
    assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'hello')
})

/** What SharedDrives keeps free on a disk of `total` bytes: 1 GB, or a twentieth of a disk smaller than 20 GB. */
const reserve = (total: number) => Math.min(1024 ** 3, Math.floor(total / 20))

test('the volume is the folder\'s file system, labelled with the drive\'s name, its free space less a reserve', async () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    const volume = await drives.volume(1)
    const s = fs.statfsSync(dir)
    assert.equal(volume.label, 'Share')
    assert.equal(volume.total, s.bsize * s.blocks)
    assert.ok(volume.free >= 0 && volume.free <= volume.total)
    // Other programs may write meanwhile: about the reserve less than the free space.
    const expected = Math.max(0, s.bsize * s.bavail - reserve(volume.total))
    assert.ok(Math.abs(volume.free - expected) < 256 * 1024 * 1024, `${volume.free} vs ${expected}`)
})

test('the server can\'t keep more than so many files open: Tabby\'s window shares its file descriptors', async () => {
    const { dir } = sandbox()
    const logged: string[] = []
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }], (m: string) => logged.push(m))
    // Opened all at once, as a server could ask: opens under way count too.
    const results = await Promise.allSettled(Array.from({ length: MAX_OPEN_FILES + 5 }, () => drives.open(1, '\\hello.txt', open())))
    const opened = results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<number>).value)
    assert.equal(opened.length, MAX_OPEN_FILES)
    assert.deepEqual([...new Set(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.code))], ['EMFILE'])
    assert.equal(await code(() => drives.open(1, '\\hello.txt', open())), 'EMFILE')
    assert.equal(logged.length, 1, 'said once, not once per refusal')
    // Closing one makes room for one.
    await drives.close(opened[0])
    const h = await drives.open(1, '\\hello.txt', open())
    assert.equal(text(await drives.read(h, 0, 5)), 'hello')
    assert.equal(await code(() => drives.open(1, '\\hello.txt', open())), 'EMFILE')
    drives.dispose()
    // A new connection starts afresh.
    const again = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }])
    await again.close(await again.open(1, '\\hello.txt', open()))
})

test('the desktops in a window share one limit on open files, so together they can\'t take the window\'s', async () => {
    const { dir } = sandbox()
    const desktops = [0, 1, 2].map(() => new SharedDrives([{ path: dir, name: 'Share', readOnly: true }]))
    try {
        // Two desktops with as many open as one may: the window has as many as all may (twice that).
        for (const d of desktops.slice(0, 2)) {
            for (let i = 0; i < MAX_OPEN_FILES; i++) {
                await d.open(1, '\\hello.txt', open())
            }
        }
        // The third has none open, and still gets none.
        assert.equal(await code(() => desktops[2].open(1, '\\hello.txt', open())), 'EMFILE')
        assert.equal(openFilesInWindow(), WINDOW_OPEN_FILES)
        assert.equal(WINDOW_OPEN_FILES, 2 * MAX_OPEN_FILES)
        // A connection ending gives its back, as its files are closed.
        desktops[0].dispose()
        await until(() => openFilesInWindow() === MAX_OPEN_FILES)
        const h = await desktops[2].open(1, '\\hello.txt', open())
        assert.equal(text(await desktops[2].read(h, 0, 5)), 'hello')
    } finally {
        desktops.forEach(d => d.dispose())
        await until(() => openFilesInWindow() === 0)
    }
})

test('an open that fails gives its place back', async () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }])
    // While they are under way, they count; once they have failed, they don't.
    const results = await Promise.all(Array.from({ length: MAX_OPEN_FILES + 5 }, () => code(() => drives.open(1, '\\missing.txt', open()))))
    assert.deepEqual(results.filter(r => r === 'ENOENT').length, MAX_OPEN_FILES)
    assert.deepEqual(results.filter(r => r === 'EMFILE').length, 5)
    assert.equal(openFilesInWindow(), 0)
    const opened = await Promise.all(Array.from({ length: MAX_OPEN_FILES }, () => drives.open(1, '\\hello.txt', open())))
    assert.equal(openFilesInWindow(), MAX_OPEN_FILES)
    await Promise.all(opened.map((h: number) => drives.close(h)))
    assert.equal(openFilesInWindow(), 0)
})

test('a file still opening when the connection ends is closed again, not left open for good', { skip: process.platform === 'win32' }, async () => {
    const { dir } = sandbox()
    const descriptors = () => fs.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length
    const before = descriptors()
    for (let i = 0; i < 20; i++) {
        const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }])
        const opening = drives.open(1, '\\hello.txt', open())
        drives.dispose()
        assert.equal(await code(() => opening), 'EBADF')
        // Nor is anything opened after.
        assert.equal(await code(() => drives.open(1, '\\hello.txt', open())), 'EBADF')
    }
    assert.equal(openFilesInWindow(), 0)
    assert.equal(descriptors(), before)
})

test('a file counts as open until its close has finished: a close held up by what is under way on the file keeps its slot', async t => {
    const { dir } = sandbox()
    // Closing waits for what is under way on the file, so a slow disk keeps the descriptor open for as long as that
    // takes: here, until the test lets go.
    const gates: (() => Promise<void>)[] = []
    const real = nodeFs.promises.open
    nodeFs.promises.open = async (...args: unknown[]) => {
        const handle = await real.apply(nodeFs.promises, args)
        const close = handle.close.bind(handle)
        handle.close = () => new Promise<void>((resolve, reject) => { gates.push(() => close().then(resolve, reject)) })
        return handle
    }
    t.after(() => { nodeFs.promises.open = real })
    const release = async () => { for (const gate of gates.splice(0)) { await gate() } }
    assert.equal(openFilesInWindow(), 0)

    // The server closes a file: its slot isn't free to another open until the close has finished, in the desktop...
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }])
    const first = await drives.open(1, '\\hello.txt', open())
    const closing = drives.close(first)
    await until(() => gates.length === 1)
    assert.equal(openFilesInWindow(), 1)
    const others = await Promise.all(Array.from({ length: MAX_OPEN_FILES - 1 }, () => drives.open(1, '\\hello.txt', open())))
    assert.equal(await code(() => drives.open(1, '\\hello.txt', open())), 'EMFILE')
    await release()
    await closing
    assert.equal(openFilesInWindow(), MAX_OPEN_FILES - 1)
    const again = await drives.open(1, '\\hello.txt', open())
    await Promise.all([...others, again].map(h => drives.close(h)).concat(release()))
    await until(() => openFilesInWindow() === 0)

    // ...and in the window, where the connection ending hands them on only as they are closed.
    const ending = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }])
    await Promise.all([1, 2, 3].map(() => ending.open(1, '\\hello.txt', open())))
    ending.dispose()
    await until(() => gates.length === 3)
    assert.equal(openFilesInWindow(), 3)
    await release()
    await until(() => openFilesInWindow() === 0)

    // A file still being opened when the connection ends is closed again, and counts until that has finished too.
    const late = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }])
    const opening = late.open(1, '\\hello.txt', open())
    late.dispose()
    await until(() => gates.length === 1)
    assert.equal(openFilesInWindow(), 1)
    await release()
    assert.equal(await code(() => opening), 'EBADF')
    assert.equal(openFilesInWindow(), 0)
})

test('a file with another name (a hard link) is read through the share but not changed: the other name may be outside', async () => {
    const { dir, other } = sandbox()
    fs.linkSync(path.join(other, 'secret.txt'), path.join(dir, 'linked.txt'))
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    assert.equal((await drives.stat(1, '\\linked.txt')).readonly, true)
    assert.equal((await drives.stat(1, '\\hello.txt')).readonly, false)
    const h = await drives.open(1, '\\linked.txt', open())
    assert.equal(text(await drives.read(h, 0, 100)), 'outside')
    await drives.close(h)
    // Writing, truncating on open (before anything else could check) and opening to create or replace: refused.
    for (const mode of [
        { write: true, create: false, exclusive: false, truncate: false },
        { write: true, create: false, exclusive: false, truncate: true },
        { write: true, create: true, exclusive: false, truncate: false },
        { write: true, create: true, exclusive: false, truncate: true },
    ]) {
        assert.equal(await code(() => drives.open(1, '\\linked.txt', mode)), 'EACCES', JSON.stringify(mode))
    }
    assert.equal(fs.readFileSync(path.join(other, 'secret.txt'), 'utf8'), 'outside')
    // Truncating on open still works for a file with one name.
    const t = await drives.open(1, '\\hello.txt', { write: true, create: true, exclusive: false, truncate: true })
    await drives.write(t, 0, bytes('new'))
    await drives.close(t)
    assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'new')
    // Removing or renaming the name in the share leaves the other one alone.
    await drives.rename(1, '\\linked.txt', '\\renamed.txt', false)
    await drives.remove(1, '\\renamed.txt')
    assert.equal(fs.readFileSync(path.join(other, 'secret.txt'), 'utf8'), 'outside')
})

const MB = 1024 * 1024

/**
 * Runs `fn` with fs.promises.statfs answering `space(dir)` (in bytes: free, and the disk's size) where it gives
 * something, as a disk of that size with that much free would.
 */
async function withDisks<T> (space: (dir: string) => { free: number, total: number } | undefined, fn: () => Promise<T>): Promise<T> {
    const statfs = nodeFs.promises.statfs
    nodeFs.promises.statfs = async (dir: string, ...rest: unknown[]) => {
        const s = space(path.resolve(dir))
        return s ? { type: 0, bsize: 1, blocks: s.total, bfree: s.free, bavail: s.free, files: 0, ffree: 0 } : statfs(dir, ...rest)
    }
    try {
        return await fn()
    } finally {
        nodeFs.promises.statfs = statfs
    }
}

/** Whether `p` is `dir` or in it. */
const within = (dir: string, p: string) => p === dir || p.startsWith(dir + path.sep)

test('a file can\'t be made larger than the data sent for it beyond the free space, less a reserve', async () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    const create = (name: string) => drives.open(1, `\\${name}`, { write: true, create: true, exclusive: true, truncate: false })
    const h = await create('grown.bin')
    const size = () => fs.statSync(path.join(dir, 'grown.bin')).size
    // A petabyte with one byte of data, written or as a new end of file; offsets past what a file can hold.
    assert.equal(await code(() => drives.write(h, 2 ** 50, bytes('x'))), 'ENOSPC')
    assert.equal(await code(() => drives.truncate(h, 2 ** 50)), 'ENOSPC')
    assert.equal(await code(() => drives.write(h, 2 ** 60, bytes('x'))), 'ENOSPC')
    assert.equal(await code(() => drives.write(h, -1, bytes('x'))), 'ENOSPC')
    assert.equal(await code(() => drives.truncate(h, 2 ** 60)), 'ENOSPC')
    assert.equal(size(), 0)
    // Data written where it goes is fine whatever the free space; smaller is always fine.
    assert.equal(await drives.write(h, 0, bytes('abc')), 3)
    assert.equal(await drives.write(h, 3, bytes('def')), 3)
    await drives.truncate(h, 2)
    await drives.close(h)
    assert.equal(fs.readFileSync(path.join(dir, 'grown.bin'), 'utf8'), 'ab')
    // On a 1 GB disk the reserve is a twentieth of it; with 8 MB more than that free, a new file may be made 8 MB long
    // without data, and not a byte more.
    const total = 1024 * MB
    const reserve = Math.floor(total / 20)
    await withDisks(d => within(fs.realpathSync(dir), d) ? { free: reserve + 8 * MB, total } : undefined, async () => {
        const a = await create('a.bin')
        assert.equal(await code(() => drives.truncate(a, 8 * MB + 1)), 'ENOSPC')
        assert.equal(await code(() => drives.truncate(a, 8 * MB)), 'ok')
        const b = await create('b.bin')
        assert.equal(await code(() => drives.write(b, 8 * MB, bytes('x'))), 'ENOSPC')
        assert.equal(await code(() => drives.write(b, 8 * MB - 1, bytes('x'))), 'ok')
        await drives.close(a)
        await drives.close(b)
    })
})

test('growing one file again and again counts what it has grown by already, not each time alone', async () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    const h = await drives.open(1, '\\sparse.bin', { write: true, create: true, exclusive: true, truncate: false })
    const file = path.join(dir, 'sparse.bin')
    const total = 1024 * MB
    const room = 16 * MB
    await withDisks(d => within(fs.realpathSync(dir), d) ? { free: Math.floor(total / 20) + room, total } : undefined, async () => {
        // A byte 6 MB past the end, ten times over: what the file has beyond what is on disk may never pass the room.
        // Where files have holes (APFS, ext4) the disk's free space doesn't change, so growing stops there; where they
        // don't, each growth takes its space for real, which the stand-in disk doesn't show: all go through.
        const results: string[] = []
        for (let i = 0; i < 10; i++) {
            results.push(await code(() => drives.write(h, fs.statSync(file).size + 6 * MB, bytes('x'))))
            const s = fs.statSync(file)
            assert.ok(s.size - s.blocks * 512 <= room, `${s.size} long, ${s.blocks * 512} on disk`)
        }
        assert.deepEqual(results.slice(0, 2), ['ok', 'ok'])
        const s = fs.statSync(file)
        if (s.blocks * 512 < s.size) {
            assert.deepEqual([...new Set(results.slice(2))], ['ENOSPC'])
        }
    })
    await drives.close(h)
})

test('growth is checked against the disk the file is on: one mounted inside the shared folder has its own space', { skip: process.platform === 'win32' }, async () => {
    const { dir } = sandbox()
    const root = fs.realpathSync(dir)
    const usb = path.join(root, 'usb')
    fs.mkdirSync(usb)
    // A small disk mounted at share/usb: what is on it has a device of its own, and the disk little free space.
    const DEVICE = 999999
    const onIt = (s: fs.Stats) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, { dev: DEVICE })
    const { stat, open } = nodeFs.promises
    nodeFs.promises.stat = async (p: string, ...rest: unknown[]) => {
        const s = await stat(p, ...rest)
        return within(usb, path.resolve(p)) ? onIt(s) : s
    }
    nodeFs.promises.open = async (p: string, ...rest: unknown[]) => {
        const handle = await open(p, ...rest)
        if (within(usb, path.resolve(p))) {
            const real = handle.stat.bind(handle)
            handle.stat = async (...args: unknown[]) => onIt(await real(...args))
        }
        return handle
    }
    const small = 64 * MB
    try {
        await withDisks(d => within(usb, d) ? { free: 60 * MB, total: small } : within(root, d) ? { free: 100 * 1024 * MB, total: 1024 * 1024 * MB } : undefined, async () => {
            const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
            const mode = { write: true, create: true, exclusive: true, truncate: false }
            // The shared folder's disk has room for this; the small one, less its reserve, doesn't.
            const onUsb = await drives.open(1, '\\usb\\fill.bin', mode)
            assert.equal(await code(() => drives.truncate(onUsb, 60 * MB - Math.floor(small / 20) + 1)), 'ENOSPC')
            assert.equal(await code(() => drives.truncate(onUsb, 32 * MB)), 'ok')
            const onShare = await drives.open(1, '\\big.bin', mode)
            assert.equal(await code(() => drives.truncate(onShare, 1024 * MB)), 'ok')
            // Its folder moved away meanwhile: the shared folder is on the other disk, so the file's space isn't known.
            fs.renameSync(usb, path.join(root, 'moved'))
            assert.equal(await code(() => drives.write(onUsb, 40 * MB, bytes('x'))), 'ENOSPC')
            drives.dispose()
        })
    } finally {
        nodeFs.promises.stat = stat
        nodeFs.promises.open = open
    }
})

test('desktops growing files on one disk take turns: each checks the free space as the growth before it left it', async () => {
    const { dir } = sandbox()
    const root = fs.realpathSync(dir)
    fs.mkdirSync(path.join(root, 'A'))
    fs.mkdirSync(path.join(root, 'B'))
    const total = 1024 * MB
    const room = 48 * MB
    // A disk without holes (HFS+): what the files there have grown to is taken from its free space, once it has landed.
    const landed = () => ['A/a.bin', 'B/b.bin'].reduce((sum, file) => sum + (fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.size ?? 0), 0)
    const free = () => Math.floor(total / 20) + room - landed()
    const { stat, statfs } = nodeFs.promises
    nodeFs.promises.statfs = async (d: string, ...rest: unknown[]) => within(root, path.resolve(d))
        ? { type: 0, bsize: 1, blocks: total, bfree: free(), bavail: free(), files: 0, ffree: 0 } : statfs(d, ...rest)
    // B's look at its folder is slow (a busy thread pool, or the disk's catalog held up): it ends once A's growth has
    // landed and A's request is answered, or after a moment, while B's reading of the free space comes at once.
    let answered = false
    nodeFs.promises.stat = async (p: string, ...rest: unknown[]) => {
        const s = await stat(p, ...rest)
        if (path.resolve(p) === path.join(root, 'B')) {
            for (let i = 0; i < 30 && !answered; i++) {
                await new Promise(resolve => setTimeout(resolve, 10))
            }
        }
        return s
    }
    try {
        const a = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
        const b = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
        const mode = { write: true, create: true, exclusive: true, truncate: false }
        const ha = await a.open(1, '\\A\\a.bin', mode)
        const hb = await b.open(1, '\\B\\b.bin', mode)
        // 30 MB each: either fits in the 48 MB there is room for, not both, whichever reads the free space first.
        const results = await Promise.all([
            code(() => a.truncate(ha, 30 * MB)).then(result => { answered = true; return result }),
            code(() => b.truncate(hb, 30 * MB)),
        ])
        assert.deepEqual(results.sort(), ['ENOSPC', 'ok'])
        assert.ok(landed() <= room, `grown by ${landed() / MB} MB, with room for ${room / MB} MB`)
        a.dispose()
        b.dispose()
    } finally {
        Object.assign(nodeFs.promises, { stat, statfs })
    }
})

test('links: inside the folder they work; out of it they don\'t exist, for reading, writing or making things', { skip: process.platform === 'win32' }, async () => {
    const { dir, other } = sandbox()
    fs.mkdirSync(path.join(other, 'elsewhere'))
    fs.symlinkSync(path.join(other, 'secret.txt'), path.join(dir, 'link-out.txt'))
    fs.symlinkSync(path.join(other, 'elsewhere'), path.join(dir, 'dir-out'))
    fs.symlinkSync(path.join(other, 'nothing-here'), path.join(dir, 'dangling'))
    fs.symlinkSync(path.join(dir, 'hello.txt'), path.join(dir, 'link-in.txt'))
    fs.symlinkSync(path.join(dir, 'sub'), path.join(dir, 'dir-in'))
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    // A link that stays inside is the file it points to.
    assert.equal((await drives.stat(1, '\\link-in.txt')).size, 5)
    assert.equal((await drives.stat(1, '\\dir-in\\deep.txt')).size, 4)
    const h = await drives.open(1, '\\link-in.txt', open())
    assert.equal(text(await drives.read(h, 0, 10)), 'hello')
    await drives.close(h)
    // One that leads out isn't there: not to look at, read, overwrite, or make things through.
    assert.equal(await drives.stat(1, '\\link-out.txt'), null)
    assert.equal(await drives.stat(1, '\\dir-out'), null)
    assert.equal(await drives.stat(1, '\\dir-out\\anything'), null)
    assert.equal(await code(() => drives.open(1, '\\link-out.txt', open())), 'ENOENT')
    assert.equal(await code(() => drives.open(1, '\\link-out.txt', { write: true, create: true, exclusive: false, truncate: true })), 'ENOENT')
    assert.equal(await code(() => drives.open(1, '\\dir-out\\new.txt', { write: true, create: true, exclusive: true, truncate: false })), 'ENOENT')
    assert.equal(await code(() => drives.open(1, '\\dangling', { write: true, create: true, exclusive: false, truncate: false })), 'ENOENT')
    assert.equal(await code(() => drives.mkdir(1, '\\dir-out\\made')), 'ENOENT')
    assert.equal(await code(() => drives.list(1, '\\dir-out')), 'ENOENT')
    assert.equal(await code(() => drives.rename(1, '\\hello.txt', '\\dir-out\\moved.txt', true)), 'ENOENT')
    assert.equal(fs.readFileSync(path.join(other, 'secret.txt'), 'utf8'), 'outside')
    assert.deepEqual(fs.readdirSync(path.join(other, 'elsewhere')), [])
    assert.ok(!fs.existsSync(path.join(other, 'nothing-here')))
    // Removing a link removes the link, whatever it points to.
    await drives.remove(1, '\\link-out.txt')
    await drives.remove(1, '\\link-in.txt')
    assert.ok(!fs.existsSync(path.join(dir, 'link-in.txt')))
    assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'hello')
    assert.equal(fs.readFileSync(path.join(other, 'secret.txt'), 'utf8'), 'outside')
})

test('a shared folder that is itself reached through a link works', { skip: process.platform === 'win32' }, async () => {
    const { dir, other } = sandbox()
    fs.symlinkSync(dir, path.join(other, 'alias'))
    const drives = new SharedDrives([{ path: path.join(other, 'alias'), name: 'Share', readOnly: false }])
    assert.equal((await drives.stat(1, '\\hello.txt')).size, 5)
    assert.deepEqual((await drives.list(1, '\\sub')), ['deep.txt'])
})

test('pipes and other special files are not served (opening one would wait forever)', { skip: process.platform === 'win32' }, async () => {
    const { dir } = sandbox()
    execFileSync('mkfifo', [path.join(dir, 'pipe')])
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    assert.equal(await drives.stat(1, '\\pipe'), null)
    assert.equal(await code(() => drives.open(1, '\\pipe', open())), 'EACCES')
    assert.equal(await code(() => drives.open(1, '\\pipe', open(true))), 'EACCES')
})

test('configured folders are tidied: names from the folder, unique, without Windows\' forbidden characters', async () => {
    const list = sharedFolders({ sharedFolders: [
        { path: '/Users/me/Documents' },
        { path: '/Volumes/Other/Documents', readOnly: true },
        { path: '/Users/me/Documents' },  // a duplicate
        { path: '/Users/me/odd', name: 'a:b*c?' },
        { path: '' },
        'nonsense',
    ] })
    assert.deepEqual(list, [
        { path: '/Users/me/Documents', name: 'Documents', readOnly: false },
        { path: '/Volumes/Other/Documents', name: 'Documents 2', readOnly: true },
        { path: '/Users/me/odd', name: 'a b c', readOnly: false },
    ])
    assert.equal(driveName('', []), 'Folder')
    assert.equal(driveName('x'.repeat(100), []).length, 64)
})
