// Files offered to the remote from this computer's clipboard (src/fileTransfer.ts, entriesFor and DiskFile): a copied
// folder goes with what is in it, but its links only as far as they stay inside it, and the walk does no more than its
// limits allow; the remote gets each file in ranges of a bounded size, and only the file that was offered.
// Runs against the built plugin: npm run build && npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { entriesFor, MAX_RANGE, MAX_ENTRIES, MAX_LOOKED_AT, MAX_LINKS } = require('../../dist/fileTransfer.js')
/** The `fs` the plugin uses (its functions are looked up on each call), to count or step into what the walk does. */
const nodeFs = require('fs')

/** Calls `fn` with `name` of the plugin's fs wrapped by `wrap` (its `native` too, if it has one), and puts it back. */
function wrapped<T> (name: string, wrap: (original: any) => any, fn: () => T): T {
    const original = nodeFs[name]
    nodeFs[name] = Object.assign(wrap(original), original.native ? { native: wrap(original.native) } : {})
    try {
        return fn()
    } finally {
        nodeFs[name] = original
    }
}

/** How often `fn` calls `name` of the plugin's fs. */
function counting<T> (name: string, fn: () => T): { result: T, calls: number } {
    let calls = 0
    const result = wrapped(name, original => function (this: unknown, ...args: unknown[]) { calls++; return original.apply(this, args) }, fn)
    return { result, calls }
}

/** Homes the tests made, removed when they are done (some hold tens of thousands of files). */
const homes: string[] = []
after(() => homes.forEach(home => fs.rmSync(home, { recursive: true, force: true })))

/** A home with secrets, and in its Downloads a folder whose links lead in and out of it, as an archive can unpack. */
function sandbox (): { home: string, folder: string } {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trd-upload-')))
    homes.push(home)
    const folder = path.join(home, 'Downloads', 'report')
    fs.mkdirSync(path.join(home, '.ssh'))
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
    fs.writeFileSync(path.join(home, '.netrc'), 'password')
    fs.mkdirSync(path.join(folder, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'README.txt'), 'readme')
    fs.writeFileSync(path.join(folder, 'sub', 'deep.txt'), 'deep')
    return { home, folder }
}

/** Each entry as the remote sees it (`folder\name`, a trailing `\` for folders), with each file's contents. */
async function offered (entries: any[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const e of entries) {
        const name = e.path !== undefined ? `${e.path}\\${e.name}` : e.name
        out[e.isDirectory ? `${name}\\` : name] = e.isDirectory ? '' : await e.file.slice(0, e.size).text()
    }
    return out
}

test('a copied folder: what is in it, and links only as far as they stay inside it', { skip: process.platform === 'win32' }, async () => {
    const { home, folder } = sandbox()
    fs.symlinkSync('../../.ssh', path.join(folder, 'attachments'))  // a folder elsewhere
    fs.symlinkSync('../../.netrc', path.join(folder, 'config'))  // a file elsewhere
    fs.symlinkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(folder, 'key'))  // the same, absolute
    fs.symlinkSync('../.ssh', path.join(folder, 'guess'))  // leads nowhere
    fs.symlinkSync('README.txt', path.join(folder, 'readme-link.txt'))  // a file inside
    fs.symlinkSync('sub', path.join(folder, 'sub-link'))  // a folder inside
    fs.symlinkSync('..', path.join(folder, 'sub', 'up'))  // a folder it is in: round and round
    fs.symlinkSync('self', path.join(folder, 'self'))  // a link to itself
    const { entries, leftOut } = entriesFor([folder])
    assert.deepEqual(await offered(entries), {
        'report\\': '',
        'report\\README.txt': 'readme',
        'report\\readme-link.txt': 'readme',
        'report\\sub\\': '',
        'report\\sub\\deep.txt': 'deep',
        'report\\sub-link\\': '',
        'report\\sub-link\\deep.txt': 'deep',
    })
    assert.equal(leftOut, 3)
})

test('what was copied itself is taken as it is, a link included: the user picked it', { skip: process.platform === 'win32' }, async () => {
    const { home, folder } = sandbox()
    fs.symlinkSync(folder, path.join(home, 'report-link'))
    fs.symlinkSync(path.join(folder, 'README.txt'), path.join(home, 'readme-link.txt'))
    const { entries, leftOut } = entriesFor([path.join(home, 'report-link'), path.join(home, 'readme-link.txt'), path.join(home, 'gone')])
    assert.deepEqual(await offered(entries), {
        'report-link\\': '',
        'report-link\\README.txt': 'readme',
        'report-link\\sub\\': '',
        'report-link\\sub\\deep.txt': 'deep',
        'readme-link.txt': 'readme',
    })
    assert.equal(leftOut, 0)
})

test('the remote gets a file a bounded range at a time: asked for more, an error, not a short answer', async () => {
    const { folder } = sandbox()
    const big = path.join(folder, 'big.bin')
    fs.writeFileSync(big, Buffer.alloc(MAX_RANGE + 10, 7))
    const [entry] = entriesFor([big]).entries
    assert.equal(entry.size, MAX_RANGE + 10)
    // Up to 4 GB in one request, of which more than MAX_RANGE is there: refused. A short answer could be taken for
    // the end of the file, and the file kept cut short.
    assert.throws(() => entry.file.slice(0, 0xFFFFFFFF), RangeError)
    assert.throws(() => entry.file.slice(0, MAX_RANGE + 1), RangeError)
    // MAX_RANGE of it is fine, and so is asking for more than there is near the end: that is its end.
    const first = await entry.file.slice(0, MAX_RANGE).arrayBuffer()
    assert.equal(first.byteLength, MAX_RANGE)
    assert.ok(new Uint8Array(first).every(b => b === 7))
    assert.equal(entry.file.slice(10, 10 + 0xFFFFFFFF).size, MAX_RANGE)
    assert.equal(entry.file.slice(MAX_RANGE, MAX_RANGE + 0xFFFFFFFF).size, 10)
    assert.equal(entry.file.slice(5, 15).size, 10)
    assert.equal(entry.file.slice(MAX_RANGE + 20, MAX_RANGE + 30).size, 0)
})

test('only the file that was offered is read, not whatever has its name by the time the remote asks', { skip: process.platform === 'win32' }, async () => {
    const { home, folder } = sandbox()
    const [readme] = entriesFor([path.join(folder, 'README.txt')]).entries
    assert.equal(await readme.file.slice(0, 100).text(), 'readme')
    assert.equal((await readme.file.read(0, 100)).toString(), 'readme')
    // Replaced by another file, or by a link to a secret: not read, here and now or ahead (FileTransfer reads ahead).
    fs.writeFileSync(path.join(folder, 'other.txt'), 'other')
    fs.renameSync(path.join(folder, 'other.txt'), path.join(folder, 'README.txt'))
    assert.throws(() => readme.file.slice(0, 100), /replaced/)
    await assert.rejects(readme.file.read(0, 100), /replaced/)
    fs.rmSync(path.join(folder, 'README.txt'))
    fs.symlinkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(folder, 'README.txt'))
    assert.throws(() => readme.file.slice(0, 100))
    await assert.rejects(readme.file.read(0, 100))
})

test('a pasted file cut short since it was offered gets an error, not a short answer the remote could take for its end', async () => {
    const { folder } = sandbox()
    const file = path.join(folder, 'README.txt')
    const [readme] = entriesFor([file]).entries
    assert.equal(readme.size, 6)
    // The same file, shorter now than the 6 bytes the remote was told it has.
    fs.truncateSync(file, 3)
    assert.throws(() => readme.file.slice(0, 6), /README.txt is shorter than when it was offered/)
    await assert.rejects(readme.file.read(2, 100), /README.txt is shorter than when it was offered/)
    // What is still there of it is read as before.
    assert.equal(await readme.file.slice(0, 3).text(), 'rea')
    assert.equal((await readme.file.read(1, 3)).toString(), 'ea')
})

test('a pasted file replaced by a pipe isn\'t waited on: reading it fails at once', { skip: process.platform === 'win32' }, () => {
    const { folder } = sandbox()
    const file = path.join(folder, 'README.txt')
    // In a process of its own: opening a pipe to read waits for a writer, here for good.
    const script = `
        const fs = require('fs'), { execFileSync } = require('child_process')
        const [entry] = require(${JSON.stringify(require.resolve('../../dist/fileTransfer.js'))}).entriesFor([${JSON.stringify(file)}]).entries
        fs.rmSync(${JSON.stringify(file)})
        execFileSync('mkfifo', [${JSON.stringify(file)}])
        try { entry.file.slice(0, 6); console.log('read') } catch (e) { console.log(e.message) }
        entry.file.read(0, 6).then(() => console.log('read ahead'), e => console.log('ahead: ' + e.message))`
    const run = spawnSync(process.execPath, ['-e', script], { timeout: 10000, encoding: 'utf8' })
    assert.equal(run.signal, null, 'still waiting on the pipe')
    assert.deepEqual(run.stdout.trim().split('\n'), ['README.txt was replaced after it was offered', 'ahead: README.txt was replaced after it was offered'])
})

test('a copied link that goes round in circles is left out, like one in a folder, and the rest is sent', { skip: process.platform === 'win32' }, async () => {
    const { home, folder } = sandbox()
    fs.symlinkSync('loop', path.join(home, 'loop'))
    const { entries } = entriesFor([path.join(home, 'loop'), path.join(folder, 'README.txt')])
    assert.deepEqual(entries.map((e: any) => e.name), ['README.txt'])
})

test('the walk does nothing past its limits: no more entries, names, folders or links looked at than they allow', { skip: process.platform === 'win32' }, () => {
    const { home } = sandbox()
    // More files than a paste takes: each one past the limit isn't even looked at.
    const many = path.join(home, 'many')
    fs.mkdirSync(many)
    for (let i = 0; i < MAX_ENTRIES + 500; i++) {
        fs.writeFileSync(path.join(many, `f${i}`), '')
    }
    const files = counting('lstatSync', () => entriesFor([many]))
    assert.ok(files.calls <= MAX_ENTRIES + 1, `${files.calls} looked at`)
    assert.equal(files.result.entries.length, MAX_ENTRIES)
    assert.equal(files.result.cut, true)
    // A folder of links that lead out: none offered, and only so many of them looked into (each costs a realpath),
    // and only so many names read.
    const links = path.join(home, 'links')
    fs.mkdirSync(links)
    for (let i = 0; i < MAX_LOOKED_AT + 100; i++) {
        fs.symlinkSync('../.ssh', path.join(links, `l${i}`))
    }
    const resolved = counting('realpathSync', () => counting('lstatSync', () => entriesFor([links])))
    const looked = resolved.result
    assert.ok(resolved.calls <= MAX_LINKS + 1, `${resolved.calls} links looked into`)
    assert.ok(looked.calls <= MAX_LOOKED_AT + 1, `${looked.calls} names looked at`)
    assert.deepEqual(looked.result.entries.map((e: any) => e.name), ['links'])
    assert.equal(looked.result.leftOut, MAX_LINKS)
    assert.equal(looked.result.cut, true)
    // Names enough for the limit in the first folder (those links, leading nowhere from there), then a thousand more
    // folders: those aren't opened, or offered.
    const wide = path.join(home, 'wide')
    fs.mkdirSync(wide)
    fs.renameSync(links, path.join(wide, 'a'))
    for (let i = 0; i < 1000; i++) {
        fs.mkdirSync(path.join(wide, `b${i}`))
    }
    const opened = counting('opendirSync', () => counting('readdirSync', () => entriesFor([wide])))
    assert.equal(opened.calls + opened.result.calls, 2, 'folders opened')
    assert.deepEqual(opened.result.result.entries.map((e: any) => e.name), ['wide', 'a'])
    assert.equal(opened.result.result.cut, true)
    // Within the limits, nothing is cut.
    assert.equal(entriesFor([path.join(home, 'Downloads', 'report')]).cut, false)
})

test('a folder swapped for a link to elsewhere while it is read isn\'t sent from', { skip: process.platform === 'win32' }, () => {
    const { home, folder } = sandbox()
    const sub = path.join(folder, 'sub')
    // Something on this computer swaps report/sub for a link to the keys just as the walk opens it to read its names.
    assert.throws(() => wrapped('opendirSync', original => function (this: unknown, dir: string, ...rest: unknown[]) {
        if (dir === sub) {
            fs.renameSync(sub, `${sub}-away`)
            fs.symlinkSync(path.join(home, '.ssh'), sub)
        }
        return original.call(this, dir, ...rest)
    }, () => entriesFor([folder])), /report\\sub changed while it was being read/)
    // Unswapped, it walks as before.
    fs.rmSync(sub)
    fs.renameSync(`${sub}-away`, sub)
    assert.deepEqual(entriesFor([folder]).entries.map((e: any) => e.name), ['report', 'README.txt', 'sub', 'deep.txt'])
    // A folder it is in swapped instead: report itself, for a link to a folder elsewhere that has a sub of its own.
    const elsewhere = path.join(home, 'elsewhere')
    fs.mkdirSync(path.join(elsewhere, 'sub'), { recursive: true })
    fs.copyFileSync(path.join(home, '.ssh', 'id_ed25519'), path.join(elsewhere, 'sub', 'deep.txt'))
    assert.throws(() => wrapped('opendirSync', original => function (this: unknown, dir: string, ...rest: unknown[]) {
        if (dir === sub && !fs.lstatSync(folder).isSymbolicLink()) {
            fs.renameSync(folder, `${folder}-away`)
            fs.symlinkSync(elsewhere, folder)
        }
        return original.call(this, dir, ...rest)
    }, () => entriesFor([folder])), /report\\sub changed while it was being read/)
})
