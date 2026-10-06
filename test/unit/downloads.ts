// Saving what the remote offers (src/fileTransfer.ts): names from the remote stay under the folder, also when the
// folder holds links, and don't read as something else; nothing existing is replaced; downloads arrive in a temporary
// file and are moved into place, marked as downloaded.
// Runs against the built plugin: npm run build && npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { savePath, safeName, place, foldersInside, markDownloaded, newFolders, DiskStorage, FileTransfer } = require('../../dist/fileTransfer.js')
/** Node's child_process as the plugin uses it (execFile is looked up on each call): to make marking fail. */
const childProcess = require('child_process')

/** The folders the tests made, removed when they are done. */
const made: string[] = []
after(() => made.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

function sandbox (): { downloads: string, elsewhere: string } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trd-save-')))
    made.push(dir)
    fs.mkdirSync(path.join(dir, 'Downloads'))
    fs.mkdirSync(path.join(dir, 'elsewhere'))
    return { downloads: path.join(dir, 'Downloads'), elsewhere: path.join(dir, 'elsewhere') }
}

test('names from the remote stay under the folder', () => {
    const { downloads } = sandbox()
    assert.equal(savePath(downloads, 'a\\b', 'c.txt'), path.join(downloads, 'a', 'b', 'c.txt'))
    assert.equal(savePath(downloads, '..\\..', '../x.txt'), path.join(downloads, 'x.txt'))
    assert.equal(savePath(downloads, 'C:\\Users', 'x.txt'), path.join(downloads, 'Users', 'x.txt'))
    assert.equal(savePath(downloads, undefined, '..'), path.join(downloads, 'file'))
})

test('names don\'t read as something else: no controls, no invisible characters that reorder or hide', () => {
    const { downloads } = sandbox()
    const saved = (name: string, folder?: string) => path.relative(downloads, savePath(downloads, folder, name))
    // A right-to-left override shows "invoice<RLO>fdp.app" as "invoiceppa.pdf".
    assert.equal(saved('invoice\u202efdp.app'), 'invoicefdp.app')
    assert.equal(saved('x', 'bundle\u202efdp.app\\Contents'), path.join('bundlefdp.app', 'Contents', 'x'))
    assert.equal(saved('report\u2066\u2067\u2068\u2069\u202a\u202b\u202c\u202d\u200e\u200f\u061c.txt'), 'report.txt')
    // DEL and C1 controls, as C0 ones; zero-width spaces, word joiners, byte order marks, line separators.
    assert.equal(saved('a\u007fb\u0085c\u009b.txt'), 'abc.txt')
    assert.equal(saved('\ufeffz\u200bw\u2060s\u00adp\u2028.txt'), 'zwsp.txt')
    // The joiners scripts and emoji need stay, and so does everything else.
    assert.equal(saved('Persian\u200cname.txt'), 'Persian\u200cname.txt')
    assert.equal(saved('family \u{1f468}\u200d\u{1f469}\u200d\u{1f467}.png'), 'family \u{1f468}\u200d\u{1f469}\u200d\u{1f467}.png')
    assert.equal(saved('Été — 日本語 résumé (1).pdf'), 'Été — 日本語 résumé (1).pdf')
    // Nothing left: a name of its own.
    assert.equal(saved('\u202e\u200b'), 'file')
    // Spelled composed, as names typed here are: an e and its accent are one letter.
    assert.equal(saved('re\u0301sume\u0301.pdf'), 'r\u00e9sum\u00e9.pdf')
    // A flag's tags stay in the flag (England's); tags anywhere else are invisible, and go.
    assert.equal(saved('\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} team.png'), '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} team.png')
    assert.equal(saved('in\u{e0065}\u{e0078}\u{e0065}voice.pdf'), 'invoice.pdf')
    // Tags after a black flag that are no subdivision's code (one country's two letters, then one to four letters or
    // digits) are text that doesn't show, of any length: they go, the flag stays.
    const tags = (text: string) => [...text].map(c => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join('')
    assert.equal(saved(`report\u{1f3f4}${tags('THIS IS HIDDEN TEXT, any length at all')}\u{e007f}.pdf`), 'report\u{1f3f4}.pdf')
    assert.equal(saved(`\u{1f3f4}${tags('gbsct')}\u{e007f}${tags('usca')}\u{e007f}.png`), `\u{1f3f4}${tags('gbsct')}\u{e007f}.png`)
    assert.equal(saved(`\u{1f3f4}${tags('gbengland')}\u{e007f}.png`), '\u{1f3f4}.png')
})

test('Windows names: no device names, no characters it refuses, no dots or spaces at the end', () => {
    const windows = (name: string) => safeName(name, true)
    for (const device of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'COM\u00b9', 'CONIN$', 'conout$']) {
        assert.equal(windows(device), `_${device}`, device)
    }
    // With an extension, or spaces before it, it is still the device.
    assert.equal(windows('NUL.txt'), '_NUL.txt')
    assert.equal(windows('nul .tar.gz'), '_nul .tar.gz')
    assert.equal(windows('CON.'), '_CON')
    assert.equal(windows('console.txt'), 'console.txt')
    assert.equal(windows('COM10'), 'COM10')
    // `:` would write into a stream of another file.
    assert.equal(windows('setup.exe:Zone.Identifier'), 'setup.exe_Zone.Identifier')
    assert.equal(windows('a<b>c"d|e?f*g.txt'), 'a_b_c_d_e_f_g.txt')
    assert.equal(windows('trailing-dot.txt.'), 'trailing-dot.txt')
    assert.equal(windows('name. . '), 'name')
    assert.equal(windows('...'), '')
    // Elsewhere those are ordinary names.
    assert.equal(safeName('CON', false), 'CON')
    assert.equal(safeName('trailing-dot.txt.', false), 'trailing-dot.txt.')
    assert.equal(safeName('a:b', false), 'a:b')
})

test('a file is created, never replaced: a taken name gets a number', async () => {
    const { downloads } = sandbox()
    const first = await place(downloads, savePath(downloads, 'sub', 'a.txt'), new Blob(['one']))
    const second = await place(downloads, savePath(downloads, 'sub', 'a.txt'), new Blob(['two']))
    assert.equal(first, path.join(downloads, 'sub', 'a.txt'))
    assert.equal(second, path.join(downloads, 'sub', 'a 2.txt'))
    assert.equal(fs.readFileSync(first, 'utf8'), 'one')
    assert.equal(fs.readFileSync(second, 'utf8'), 'two')
})

test('a link in the folder doesn\'t take files elsewhere', { skip: process.platform === 'win32' }, async () => {
    const { downloads, elsewhere } = sandbox()
    // A folder name the remote may choose, linked out of Downloads; and a file name linked to a file elsewhere.
    fs.symlinkSync(elsewhere, path.join(downloads, 'photos'))
    fs.writeFileSync(path.join(elsewhere, 'target.txt'), 'kept')
    fs.symlinkSync(path.join(elsewhere, 'target.txt'), path.join(downloads, 'notes.txt'))
    fs.symlinkSync(path.join(elsewhere, 'not-there-yet'), path.join(downloads, 'dangling.txt'))
    await assert.rejects(place(downloads, savePath(downloads, 'photos', 'x.txt'), new Blob(['x'])), /leaves the folder/)
    await assert.rejects(foldersInside(downloads, path.join(downloads, 'photos', 'deeper')), /leaves the folder/)
    assert.deepEqual(fs.readdirSync(elsewhere), ['target.txt'])
    // The linked names are taken: the files go next to them.
    assert.equal(await place(downloads, savePath(downloads, undefined, 'notes.txt'), new Blob(['new'])), path.join(downloads, 'notes 2.txt'))
    assert.equal(await place(downloads, savePath(downloads, undefined, 'dangling.txt'), new Blob(['new'])), path.join(downloads, 'dangling 2.txt'))
    assert.equal(fs.readFileSync(path.join(elsewhere, 'target.txt'), 'utf8'), 'kept')
    assert.deepEqual(fs.readdirSync(elsewhere), ['target.txt'])
    // A link that stays inside is fine.
    fs.mkdirSync(path.join(downloads, 'real'))
    fs.symlinkSync(path.join(downloads, 'real'), path.join(downloads, 'alias'))
    assert.equal(await place(downloads, savePath(downloads, 'alias', 'y.txt'), new Blob(['y'])), path.join(downloads, 'real', 'y.txt'))
})

test('a download arrives in a temporary file and is moved into place', async () => {
    const { downloads } = sandbox()
    const storage = new DiskStorage()
    const handle = await storage.createWriteHandle('big.bin', 6)
    await handle.write(new Uint8Array([1, 2, 3, 4]))
    await handle.write(new Uint8Array([5, 6]))
    assert.equal(handle.bytesWritten, 6)
    const blob = await handle.finalize()
    assert.equal(blob.size, 0)  // not in memory
    // The temporary file it names, in the storage's own folder (other programs may have such folders too).
    const temporary: string = blob[Object.getOwnPropertySymbols(blob).find(s => s.description === 'tabby-rdp download')!]
    const folder = path.dirname(temporary)
    assert.ok(path.basename(folder).startsWith('tabby-rdp-'), folder)
    const target = await place(downloads, savePath(downloads, undefined, 'big.bin'), blob)
    assert.deepEqual([...fs.readFileSync(target)], [1, 2, 3, 4, 5, 6])
    assert.ok(!fs.existsSync(temporary))
    // An aborted one leaves nothing; disposing removes the temporary folder.
    const dropped = await storage.createWriteHandle('dropped.bin', 10)
    await dropped.write(new Uint8Array([9]))
    await dropped.abort()
    assert.deepEqual(fs.readdirSync(folder), [])
    await storage.dispose()
    assert.ok(!fs.existsSync(folder))
})

test('a file that fails to be written whole isn\'t left part written, and nothing that was there is touched', async () => {
    const { downloads } = sandbox()
    fs.writeFileSync(path.join(downloads, 'report.pdf'), 'the user\'s own')
    const storage = new DiskStorage()
    const handle = await storage.createWriteHandle('report.pdf', 4)
    await handle.write(new Uint8Array([1, 2, 3, 4]))
    const blob = await handle.finalize()
    // The disk fills up partway through the copy.
    const promises = require('fs').promises
    const copyFile = promises.copyFile
    promises.copyFile = async (_from: string, to: string) => {
        await promises.writeFile(to, Buffer.from([1, 2]), { flag: 'wx' })
        // As Node's does when it fails after opening the file it makes: what it made goes.
        await promises.rm(to)
        throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' })
    }
    try {
        await assert.rejects(place(downloads, savePath(downloads, undefined, 'report.pdf'), blob), { code: 'ENOSPC' })
    } finally {
        promises.copyFile = copyFile
    }
    // Its temporary file gone (the connection ended): the copy fails before writing anything.
    await storage.dispose()
    await assert.rejects(place(downloads, savePath(downloads, undefined, 'report.pdf'), blob), { code: 'ENOENT' })
    assert.deepEqual(fs.readdirSync(downloads), ['report.pdf'])
    assert.equal(fs.readFileSync(path.join(downloads, 'report.pdf'), 'utf8'), 'the user\'s own')
})

test('what another program made at the name meanwhile isn\'t removed when this file fails before anything of it was made', async () => {
    const { downloads } = sandbox()
    const promises = require('fs').promises
    // A file that can't be read, from memory: another program makes the file at the name that was free as this waits.
    const unreadable = new Blob(['x'])
    ;(unreadable as any).arrayBuffer = async () => {
        fs.writeFileSync(path.join(downloads, 'a.txt'), 'another program\'s')
        throw new Error('the file can\'t be read')
    }
    await assert.rejects(place(downloads, savePath(downloads, undefined, 'a.txt'), unreadable), /can't be read/)
    assert.equal(fs.readFileSync(path.join(downloads, 'a.txt'), 'utf8'), 'another program\'s')
    // The same for a copy that fails before it made anything (its temporary file is gone, say).
    const storage = new DiskStorage()
    const handle = await storage.createWriteHandle('b.txt', 1)
    await handle.write(new Uint8Array([1]))
    const blob = await handle.finalize()
    const copyFile = promises.copyFile
    promises.copyFile = async (_from: string, to: string) => {
        fs.writeFileSync(to, 'another program\'s')
        throw Object.assign(new Error('ENOENT: no such file or directory, copyfile'), { code: 'ENOENT' })
    }
    try {
        await assert.rejects(place(downloads, savePath(downloads, undefined, 'b.txt'), blob), { code: 'ENOENT' })
    } finally {
        promises.copyFile = copyFile
        await storage.dispose()
    }
    assert.equal(fs.readFileSync(path.join(downloads, 'b.txt'), 'utf8'), 'another program\'s')
})

test('a file written from memory that fails partway goes again; one that can\'t be removed is said to stay, not dropped from the message', async () => {
    const { downloads } = sandbox()
    const promises = require('fs').promises
    const { open, rm } = promises
    // The disk fills up partway through writing a file of this call's making.
    promises.open = async (...args: unknown[]) => {
        const file = await open.apply(promises, args)
        file.writeFile = async () => {
            await file.write(Buffer.from([1, 2]))
            throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
        }
        return file
    }
    try {
        await assert.rejects(place(downloads, savePath(downloads, undefined, 'big.txt'), new Blob(['abcd'])), { code: 'ENOSPC', message: /^ENOSPC: no space left on device, write$/ })
        assert.deepEqual(fs.readdirSync(downloads), [])
        // It can't be removed either: the message says the part of it stays.
        promises.rm = async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }
        await assert.rejects(place(downloads, savePath(downloads, undefined, 'big2.txt'), new Blob(['abcd'])),
            (e: any) => e.code === 'ENOSPC' && /^ENOSPC: no space left on device, write \(big2\.txt was saved in part and couldn't be removed: EACCES: permission denied\)$/.test(e.message))
        assert.deepEqual(fs.readdirSync(downloads), ['big2.txt'])
    } finally {
        Object.assign(promises, { open, rm })
    }
})

/** What marks a file as downloaded here: macOS's quarantine attribute, Windows' Zone.Identifier stream; none on Linux. */
function downloadMark (file: string): string | null {
    try {
        if (process.platform === 'darwin') {
            return execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        }
        if (process.platform === 'win32') {
            return fs.readFileSync(`${file}:Zone.Identifier`, 'utf8')
        }
    } catch {
        return null
    }
    return null
}

test('what is saved is marked as downloaded, and so are the folders made for it, not those already there', async () => {
    const { downloads } = sandbox()
    fs.mkdirSync(path.join(downloads, 'mine'))
    const made: string[] = []
    const target = await place(downloads, savePath(downloads, 'mine\\Tool.app\\Contents', 'Info.plist'), new Blob(['x']), made)
    assert.deepEqual(made, [path.join(downloads, 'mine', 'Tool.app'), path.join(downloads, 'mine', 'Tool.app', 'Contents')])
    for (const item of [...made, target]) {
        assert.equal(await markDownloaded(item), null, item)
    }
    if (process.platform === 'darwin') {
        // Downloaded and not yet opened, when, by Tabby: what makes Gatekeeper ask before the app first opens.
        for (const item of [...made, target]) {
            assert.match(downloadMark(item) ?? '', /^0081;[0-9a-f]+;Tabby;$/, item)
        }
    } else if (process.platform === 'win32') {
        assert.match(downloadMark(target) ?? '', /ZoneId=3/)
    }
    // A folder that was there before isn't the remote's: left as it was.
    assert.equal(downloadMark(path.join(downloads, 'mine')), null)
    assert.equal(fs.readFileSync(target, 'utf8'), 'x')
})

test('Save to Downloads: safe names, files and their new folders marked as downloaded', async () => {
    const { downloads } = sandbox()
    // Just enough of a page and of IronRDP's provider for FileTransfer: the remote offers files, the user saves them.
    const element = (): any => ({
        className: '', textContent: '', title: '', classList: { add () {}, remove () {} },
        append () {}, appendChild () {}, addEventListener () {}, removeEventListener () {}, remove () {}, contains: () => false,
    })
    const globals = globalThis as any
    const hadDocument = 'document' in globals
    globals.document ??= { createElement: element }
    try {
        let offer: (files: any[]) => void = () => null
        class Provider {
            on (event: string, handler: any) { if (event === 'files-available') offer = handler }
            off () {}
            downloadFile (file: any) { return { completion: Promise.resolve(new Blob([`content of ${file.name}`])) } }
            handleFileContentsRequest () {}
            dispose () {}
        }
        const log: string[] = []
        // The clipboard goes both ways with this desktop (see test/unit/clipboard-files.ts for the others).
        const files = new FileTransfer({ RdpFileTransferProvider: Provider }, element(), (m: string) => log.push(m), () => ({ toRemote: true, fromRemote: true }))
        offer([
            { name: 'invoice\u202efdp.app', size: 1 },
            { name: 'x', path: 'bundle\u202efdp.app\\Contents\\MacOS', size: 1 },
            { name: 'folder', size: 0, isDirectory: true },
        ])
        const saved: string[] = await files.saveAll(downloads)
        assert.deepEqual(saved.map(p => path.relative(downloads, p)), ['invoicefdp.app', path.join('bundlefdp.app', 'Contents', 'MacOS', 'x')])
        assert.equal(fs.readFileSync(saved[0], 'utf8'), 'content of invoice\u202efdp.app')
        if (process.platform === 'darwin') {
            for (const item of [...saved, path.join(downloads, 'bundlefdp.app'), path.join(downloads, 'bundlefdp.app', 'Contents', 'MacOS')]) {
                assert.match(downloadMark(item) ?? '', /;Tabby;$/, item)
            }
        }
        assert.ok(!log.some(l => /not marked/.test(l)), log.join('\n'))
        files.dispose()
    } finally {
        if (!hadDocument) {
            delete globals.document
        }
    }
})

/**
 * A FileTransfer over just enough of a page and of IronRDP's provider: the remote offers `files`, and each comes as
 * `download(file)` makes it. What it showed and logged.
 */
function saving (download: (file: any) => Promise<Blob>) {
    const shown: string[] = []
    const element = (): any => ({
        className: '', textContent: '', title: '', classList: { add () {}, remove () {} }, children: [] as any[],
        append (...nodes: any[]) { this.children.push(...nodes) }, appendChild (el: any) { shown.push(el.children[0]?.textContent ?? '') },
        addEventListener () {}, removeEventListener () {}, remove () {}, contains: () => false,
    })
    const globals = globalThis as any
    globals.document ??= { createElement: element }
    let offer: (files: any[]) => void = () => null
    class Provider {
        on (event: string, handler: any) { if (event === 'files-available') offer = handler }
        off () {}
        downloadFile (file: any) { return { completion: download(file) } }
        handleFileContentsRequest () {}
        dispose () {}
    }
    const log: string[] = []
    const files = new FileTransfer({ RdpFileTransferProvider: Provider }, element(), (m: string) => log.push(m), () => ({ toRemote: true, fromRemote: true }))
    return { files, shown, log, offer: (list: any[]) => offer(list) }
}

test('a saved file whose temporary copy can\'t be removed is saved and marked all the same', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const { downloads } = sandbox()
    const storage = new DiskStorage()
    const handle = await storage.createWriteHandle('tool.command', 2)
    await handle.write(new Uint8Array([1, 2]))
    const blob = await handle.finalize()
    const temporary: string = blob[Object.getOwnPropertySymbols(blob).find(s => s.description === 'tabby-rdp download')!]
    // Its folder can't be changed: the copy works, removing the temporary file doesn't.
    fs.chmodSync(path.dirname(temporary), 0o500)
    try {
        const s = saving(async () => blob)
        s.offer([{ name: 'tool.command', size: 2 }])
        const saved: string[] = await s.files.saveAll(downloads)
        assert.deepEqual(saved, [path.join(downloads, 'tool.command')])
        assert.deepEqual([...fs.readFileSync(saved[0])], [1, 2])
        assert.match(s.shown.at(-1)!, /^Saved 1 file to Downloads$/)
        if (process.platform === 'darwin') {
            assert.match(downloadMark(saved[0]) ?? '', /;Tabby;$/)
        }
        s.files.dispose()
    } finally {
        fs.chmodSync(path.dirname(temporary), 0o700)
        await storage.dispose()
    }
})

test('a save that fails partway says what was saved before, and that some of it may not be marked', async () => {
    const { downloads } = sandbox()
    const s = saving(async file => {
        if (file.name === 'second.txt') {
            throw new Error('the remote stopped sending it')
        }
        return new Blob([`content of ${file.name}`])
    })
    s.offer([{ name: 'first.txt', size: 1 }, { name: 'second.txt', size: 1 }])
    // Where downloads are marked with xattr (macOS), marking fails here.
    const execFile = childProcess.execFile
    childProcess.execFile = (...args: any[]) => args.at(-1)(new Error('xattr: not supported'), '', 'xattr: not supported')
    try {
        const saved: string[] = await s.files.saveAll(downloads)
        assert.deepEqual(saved, [path.join(downloads, 'first.txt')])
        const unmarked = process.platform === 'darwin' ? '\nNot all of it could be marked as downloaded, so the system may not warn before opening it' : ''
        assert.equal(s.shown.at(-1), `Saving failed: the remote stopped sending it\n1 file saved before that${unmarked}`)
        assert.deepEqual(s.files.lastSaved, saved)
    } finally {
        childProcess.execFile = execFile
        s.files.dispose()
    }
})

test('a folder made at the name meanwhile isn\'t adopted: the remote\'s files go into one made for them, as the name is chosen', async () => {
    const { downloads } = sandbox()
    // Another program (or the user) makes a folder of the name the remote's files would take, while the first of them
    // comes: the files go into a folder of their own, not among what it holds.
    const s = saving(async file => {
        if (file.name === 'a.txt') {
            fs.mkdirSync(path.join(downloads, 'Project'))
            fs.writeFileSync(path.join(downloads, 'Project', 'mine.txt'), 'the user\'s own')
        }
        return new Blob([`content of ${file.name}`])
    })
    s.offer([{ name: 'a.txt', path: 'Project', size: 1 }, { name: 'b.txt', path: 'Project', size: 1 }])
    try {
        const saved: string[] = await s.files.saveAll(downloads)
        assert.deepEqual(saved.map(p => path.relative(downloads, p)), [path.join('Project 2', 'a.txt'), path.join('Project 2', 'b.txt')])
        assert.deepEqual(fs.readdirSync(path.join(downloads, 'Project')), ['mine.txt'])
        if (process.platform === 'darwin') {
            for (const item of [...saved, path.join(downloads, 'Project 2')]) {
                assert.match(downloadMark(item) ?? '', /;Tabby;$/, item)
            }
            assert.equal(downloadMark(path.join(downloads, 'Project')), null)
        }
    } finally {
        s.files.dispose()
    }
})

test('a top folder is made as it is chosen, a name taken by a file or a link too, and one that a failed save made is taken away again if empty', async () => {
    const { downloads, elsewhere } = sandbox()
    const into = newFolders(downloads)
    // Taken by a file, and by a link (not followed): the next number, made at once.
    fs.writeFileSync(path.join(downloads, 'Docs'), 'a file')
    fs.symlinkSync(elsewhere, path.join(downloads, 'Docs 2'))
    const made: string[] = []
    assert.equal(into(path.join(downloads, 'Docs', 'a.txt'), made), path.join(downloads, 'Docs 3', 'a.txt'))
    assert.deepEqual([made, fs.readdirSync(elsewhere)], [[path.join(downloads, 'Docs 3')], []])
    assert.ok(fs.statSync(path.join(downloads, 'Docs 3')).isDirectory())
    // The same folder for the next file in it, and not reported as made again; a file at the top is none of its own.
    assert.equal(into(path.join(downloads, 'Docs', 'sub', 'b.txt'), made), path.join(downloads, 'Docs 3', 'sub', 'b.txt'))
    assert.equal(into(path.join(downloads, 'top.txt'), made), path.join(downloads, 'top.txt'))
    assert.deepEqual([made.length, into.made], [1, [path.join(downloads, 'Docs 3')]])
    // A save that fails before anything went into the folder it made (the disk is full) leaves no empty folder.
    const storage = new DiskStorage()
    const handle = await storage.createWriteHandle('a.txt', 1)
    await handle.write(new Uint8Array([1]))
    const blob = await handle.finalize()
    const s = saving(async () => blob)
    s.offer([{ name: 'a.txt', path: 'Project', size: 1 }])
    const promises = require('fs').promises
    const copyFile = promises.copyFile
    promises.copyFile = async () => { throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' }) }
    try {
        assert.deepEqual(await s.files.saveAll(downloads), [])
        assert.match(s.shown.at(-1)!, /^Saving failed: ENOSPC/)
    } finally {
        promises.copyFile = copyFile
        s.files.dispose()
        await storage.dispose()
    }
    assert.ok(!fs.existsSync(path.join(downloads, 'Project')))
})

test('what the remote sends goes into folders of its own, not into one of the same name that was there', async () => {
    const { downloads } = sandbox()
    // An app of the user's in Downloads, which the remote could name to add a file to it.
    fs.mkdirSync(path.join(downloads, 'Tool.app', 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(downloads, 'Tool.app', 'Contents', 'MacOS', 'Tool'), 'the app')
    const s = saving(async file => new Blob([`content of ${file.name}`]))
    s.offer([
        { name: 'helper', path: 'Tool.app\\Contents\\MacOS', size: 1 },
        { name: 'Info.plist', path: 'Tool.app\\Contents', size: 1 },
        { name: 'notes.txt', size: 1 },
    ])
    try {
        const saved: string[] = await s.files.saveAll(downloads)
        // One new folder for both of its files, numbered as a file would be.
        assert.deepEqual(saved.map(p => path.relative(downloads, p)), [
            path.join('Tool 2.app', 'Contents', 'MacOS', 'helper'),
            path.join('Tool 2.app', 'Contents', 'Info.plist'),
            'notes.txt',
        ])
        assert.deepEqual(fs.readdirSync(path.join(downloads, 'Tool.app', 'Contents', 'MacOS')), ['Tool'])
        if (process.platform === 'darwin') {
            for (const item of [...saved, path.join(downloads, 'Tool 2.app'), path.join(downloads, 'Tool 2.app', 'Contents')]) {
                assert.match(downloadMark(item) ?? '', /;Tabby;$/, item)
            }
            assert.equal(downloadMark(path.join(downloads, 'Tool.app')), null)
        }
    } finally {
        s.files.dispose()
    }
})
