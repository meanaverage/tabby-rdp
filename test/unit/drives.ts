// The shared folders' file system (src/drives.ts, SharedDrives): what IronRDP's drive backend calls with the
// server's paths. Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
const { SharedDrives, sharedFolders, driveName } = require('../../dist/drives.js')

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString()
const bytes = (s: string) => new Uint8Array(Buffer.from(s))
const open = (write = false) => ({ write, create: write, exclusive: false, truncate: false })
const code = (f: () => unknown) => {
    try {
        f()
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

test('paths are the drive\'s: backslashes, the root, and nothing outside the folder', () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    assert.deepEqual(drives.drives, [{ id: 1, name: 'Share' }])
    assert.equal(drives.stat(1, '\\').dir, true)
    assert.equal(drives.stat(1, '\\hello.txt').size, 5)
    assert.equal(drives.stat(1, 'sub/deep.txt').size, 4)
    assert.equal(drives.stat(1, '\\missing.txt'), null)
    assert.deepEqual(drives.list(1, '\\').sort(), ['hello.txt', 'sub'])
    // The folder above holds secret.txt: not reachable, however the path is spelled.
    for (const escape of ['\\..\\secret.txt', '..\\secret.txt', '\\sub\\..\\..\\secret.txt', '/../secret.txt']) {
        assert.equal(code(() => drives.stat(1, escape)), 'ENOENT', escape)
    }
    assert.equal(code(() => drives.stat(2, '\\')), 'ENOENT')
})

test('files read and write at offsets, through handles', () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    const h = drives.open(1, '\\hello.txt', open())
    assert.equal(text(drives.read(h, 0, 100)), 'hello')
    assert.equal(text(drives.read(h, 1, 2)), 'el')
    assert.equal(drives.read(h, 5, 10).length, 0)
    assert.equal(code(() => drives.write(h, 0, bytes('x'))), 'EBADF')  // opened for reading
    drives.close(h)
    const w = drives.open(1, '\\new.txt', { write: true, create: true, exclusive: true, truncate: false })
    assert.equal(drives.write(w, 0, bytes('abcdef')), 6)
    assert.equal(drives.write(w, 2, bytes('XY')), 2)
    drives.truncate(w, 5)
    drives.close(w)
    assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'abXYe')
    assert.equal(code(() => drives.open(1, '\\new.txt', { write: true, create: true, exclusive: true, truncate: false })), 'EEXIST')
    assert.equal(code(() => drives.read(w, 0, 1)), 'EBADF')  // closed
})

test('folders are made, renamed and removed; a rename replaces only when told to', () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    drives.mkdir(1, '\\made')
    assert.equal(drives.stat(1, '\\made').dir, true)
    assert.equal(code(() => drives.mkdir(1, '\\made')), 'EEXIST')
    assert.equal(code(() => drives.remove(1, '\\sub')), 'ENOTEMPTY')
    drives.rename(1, '\\hello.txt', '\\made\\moved.txt', false)
    assert.equal(fs.readFileSync(path.join(dir, 'made', 'moved.txt'), 'utf8'), 'hello')
    assert.equal(code(() => drives.rename(1, '\\sub\\deep.txt', '\\made\\moved.txt', false)), 'EEXIST')
    drives.rename(1, '\\sub\\deep.txt', '\\made\\moved.txt', true)
    assert.equal(fs.readFileSync(path.join(dir, 'made', 'moved.txt'), 'utf8'), 'deep')
    // The same file under another spelling (case-insensitive file systems see it as existing).
    drives.rename(1, '\\made\\moved.txt', '\\made\\MOVED.txt', false)
    assert.ok(fs.readdirSync(path.join(dir, 'made')).includes('MOVED.txt'))
    drives.remove(1, '\\made\\MOVED.txt')
    drives.remove(1, '\\made')
    drives.remove(1, '\\sub')
    assert.deepEqual(drives.list(1, '\\'), [])
    assert.equal(code(() => drives.remove(1, '\\')), 'EACCES')  // the shared folder itself
    assert.ok(fs.existsSync(dir))
})

test('a read-only folder refuses every change and reports its files read-only', () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: true }])
    assert.equal(drives.stat(1, '\\hello.txt').readonly, true)
    const h = drives.open(1, '\\hello.txt', open())
    assert.equal(text(drives.read(h, 0, 5)), 'hello')
    drives.close(h)
    assert.equal(code(() => drives.open(1, '\\hello.txt', open(true))), 'EACCES')
    assert.equal(code(() => drives.open(1, '\\new.txt', { write: false, create: true, exclusive: false, truncate: false })), 'EACCES')
    assert.equal(code(() => drives.mkdir(1, '\\made')), 'EACCES')
    assert.equal(code(() => drives.remove(1, '\\hello.txt')), 'EACCES')
    assert.equal(code(() => drives.rename(1, '\\hello.txt', '\\bye.txt', false)), 'EACCES')
    assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'hello')
})

test('the volume is the folder\'s file system, labelled with the drive\'s name', () => {
    const { dir } = sandbox()
    const drives = new SharedDrives([{ path: dir, name: 'Share', readOnly: false }])
    const volume = drives.volume(1)
    assert.equal(volume.label, 'Share')
    assert.ok(volume.total > 0 && volume.free > 0 && volume.free <= volume.total)
})

test('configured folders are tidied: names from the folder, unique, without Windows\' forbidden characters', () => {
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
