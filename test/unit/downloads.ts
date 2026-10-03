// Saving what the remote offers (src/fileTransfer.ts): names from the remote stay under the folder, also when the
// folder holds links; nothing existing is replaced; downloads arrive in a temporary file and are moved into place.
// Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
const { savePath, place, foldersInside, DiskStorage } = require('../../dist/fileTransfer.js')

function sandbox (): { downloads: string, elsewhere: string } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trd-save-')))
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
    const handle = await storage.createWriteHandle('big.bin', 10)
    await handle.write(new Uint8Array([1, 2, 3, 4]))
    await handle.write(new Uint8Array([5, 6]))
    assert.equal(handle.bytesWritten, 6)
    const blob = await handle.finalize()
    assert.equal(blob.size, 0)  // not in memory
    const target = await place(downloads, savePath(downloads, undefined, 'big.bin'), blob)
    assert.deepEqual([...fs.readFileSync(target)], [1, 2, 3, 4, 5, 6])
    // An aborted one leaves nothing; disposing removes the temporary folder.
    const dropped = await storage.createWriteHandle('dropped.bin', 10)
    await dropped.write(new Uint8Array([9]))
    await dropped.abort()
    await storage.dispose()
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('tabby-rdp-')).map(n => fs.readdirSync(path.join(os.tmpdir(), n)).length).filter(Boolean), [])
})
