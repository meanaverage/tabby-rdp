// The shared folders' file system (src/drives.ts, SharedDrives): what IronRDP's drive backend calls with the
// server's paths. Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { SharedDrives, sharedFolders, driveName } = require('../../dist/drives.js')

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

function sandbox (): { dir: string, other: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-drive-'))
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

test('the volume is the folder\'s file system, labelled with the drive\'s name', async () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    const volume = await drives.volume(1)
    assert.equal(volume.label, 'Share')
    assert.ok(volume.total > 0 && volume.free > 0 && volume.free <= volume.total)
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
