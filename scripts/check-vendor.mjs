#!/usr/bin/env node
// vendor/ is IronRDP's build, committed: vendor/SHA256SUMS (which scripts/build-ironrdp.sh writes) lists what it was
// built from and the hash of each file. These checks hold the list, the build and a release to each other, with
// nothing but Node.js and git, so that they can run where no dependency should (the job that publishes):
//
//   node scripts/check-vendor.mjs base
//       ironrdp/BASE_COMMIT is in IronRDP's own history (scripts/build-ironrdp.sh runs this before building).
//   node scripts/check-vendor.mjs rebuilt
//       vendor/, as just rebuilt into an empty folder, is byte for byte what the commit has (CI's rebuild,
//       .github/workflows/ironrdp.yml).
//   node scripts/check-vendor.mjs package <package.tgz> [<revision>] [--same-as <package.tgz>]
//       a package (npm pack's, or a staged release from npm stage download) holds the revision's files and nothing
//       else: vendor/ as the revision's vendor/SHA256SUMS lists it, every other file but dist/ as in the revision. The
//       revision is v<the package's version> unless named. dist/ is built, so it can only be compared with another
//       build: --same-as checks every file, dist/ included, against a package made from the same revision.
//
// The unit tests (test/unit/vendor.ts) run these on made-up repositories and packages, and check the working tree
// against the list.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, inflateRawSync } from 'node:zlib'

export const UPSTREAM = 'https://github.com/Devolutions/IronRDP.git'
export const MANIFEST = 'vendor/SHA256SUMS'

export const sha256 = data => createHash('sha256').update(data).digest('hex')

/** git in a folder; its output. Throws if git fails. */
function git (cwd, args) {
    return execFileSync('git', args, { cwd, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A name as it can be shown in a line of text or a table: as it is, or quoted, with anything but printable ASCII
 * (controls, letters that reorder text, look-alikes) and the characters that would end the quote or a table cell
 * escaped. */
const shown = name => /^[\w.,+@/ -]+$/.test(name) ? name
    : `"${[...name].map(c => /^[\x20-\x7e]$/.test(c) && !'"\\`|'.includes(c) ? c : `\\u{${c.codePointAt(0).toString(16)}}`).join('')}"`

/** vendor/SHA256SUMS's entries: each path (from the repository's root) and its SHA-256. Its comments don't count. */
export function parseManifest (text) {
    const sums = new Map()
    for (const line of text.split(/\r?\n/)) {
        if (line === '' || line.startsWith('#')) {
            continue
        }
        const sum = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
        if (!sum) {
            throw new Error(`${MANIFEST}: not a checksum line: ${shown(line)}`)
        }
        if (sums.has(sum[2])) {
            throw new Error(`${MANIFEST}: ${shown(sum[2])} is listed twice`)
        }
        sums.set(sum[2], sum[1])
    }
    return sums
}

/** The files that are text: a Windows checkout may have given them CRLF line ends. Others are compared as they are. */
export const isText = file => /(\.js|\.patch|\/BASE_COMMIT|\/IRONRDP-LICENSE|\/SHA256SUMS)$/.test(file)

/** Whether a file's bytes are what the list hashed, allowing a text file CRLF line ends. */
export function sameFile (file, data, hash) {
    return sha256(data) === hash ||
        isText(file) && sha256(Buffer.from(data.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')) === hash
}

/** Every file in a folder and the folders in it, hidden ones included, from root; and what is neither a file nor a
 * folder (a link, say), which no build makes. */
export function walk (root, dir) {
    const files = []
    const odd = []
    const visit = folder => {
        for (const name of readdirSync(join(root, folder)).sort()) {
            const path = `${folder}/${name}`
            const stat = lstatSync(join(root, path))
            if (stat.isDirectory()) {
                visit(path)
            } else if (stat.isFile()) {
                files.push(path)
            } else {
                odd.push(path)
            }
        }
    }
    visit(dir)
    return { files, odd }
}

/** The working tree against vendor/SHA256SUMS: what is there but unlisted, listed but missing, changed, or not a
 * plain file. What is listed: the base commit, the patches the build applies, and everything in vendor/. */
export function checkTree (root) {
    const sums = parseManifest(readFileSync(join(root, MANIFEST), 'utf8'))
    const exists = file => {
        try {
            lstatSync(join(root, file))
            return true
        } catch {
            return false
        }
    }
    const vendor = walk(root, 'vendor')
    const present = [
        ...['ironrdp/BASE_COMMIT'].filter(exists),
        // patches/*.patch, as the build applies them: the shell's * leaves out hidden files.
        ...readdirSync(join(root, 'ironrdp/patches')).filter(name => name.endsWith('.patch') && !name.startsWith('.'))
            .map(name => `ironrdp/patches/${name}`),
        // Everything else in vendor/ but Finder's folder settings, which npm never packs.
        ...vendor.files.filter(file => file !== MANIFEST && !file.endsWith('/.DS_Store')),
    ]
    const plain = file => lstatSync(join(root, file)).isFile()
    return {
        unlisted: present.filter(file => !sums.has(file)).sort(),
        missing: [...sums.keys()].filter(file => !present.includes(file)).sort(),
        changed: present.filter(file => sums.has(file) && plain(file) && !sameFile(file, readFileSync(join(root, file)), sums.get(file))).sort(),
        odd: [...present.filter(file => !plain(file)), ...vendor.odd].sort(),
    }
}

/** A revision's files (under a folder, or all of them): each path, with its mode, git's type and object id. Read
 * NUL-delimited, so that any name comes through whole. */
export function tree (root, revision, dir) {
    const entries = new Map()
    const args = ['ls-tree', '-r', '-z', '--full-tree', revision]
    if (dir) {
        args.push('--', dir)
    }
    for (const line of git(root, args).toString('utf8').split('\0')) {
        if (line === '') {
            continue
        }
        const [, mode, type, oid, path] = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line)
        entries.set(path, { mode, type, oid })
    }
    return entries
}

/** A plain file in git's terms: a blob, executable or not (a link is a blob too, of another mode). */
const plainBlob = entry => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')

const blob = (root, oid) => git(root, ['cat-file', 'blob', oid])

/** vendor/ as just rebuilt (the working tree) against what the revision has there, file by file, and the two lists'
 * entries. Each file either side has is compared: one the other side doesn't have is a difference, as is anything
 * that isn't a plain file. The lists' comments say where and with what each was built, so only their entries count. */
export function compareRebuilt (root, revision = 'HEAD') {
    const committed = tree(root, revision, 'vendor')
    const rebuilt = walk(root, 'vendor')
    // Finder's folder settings, which a Mac can leave in a folder looked at and npm never packs, aren't the build's
    // (committed ones still differ).
    rebuilt.files = rebuilt.files.filter(file => !file.endsWith('/.DS_Store'))
    const odd = [
        ...[...committed].filter(([, entry]) => !plainBlob(entry)).map(([path, entry]) => `${shown(path)} (committed, git mode ${entry.mode})`),
        ...rebuilt.odd.map(path => `${shown(path)} (rebuilt, not a file)`),
    ]
    const files = [...new Set([...committed.keys(), ...rebuilt.files])].filter(file => file !== MANIFEST).sort().map(file => {
        const entry = committed.get(file)
        const before = entry && plainBlob(entry) ? sha256(blob(root, entry.oid)) : null
        const after = rebuilt.files.includes(file) ? sha256(readFileSync(join(root, file))) : null
        // Found on neither side can't happen when both sides are listed whole; it would still be a difference.
        return { file, committed: before, rebuilt: after, same: before !== null && before === after }
    })
    const list = committed.get(MANIFEST)
    const lists = {
        committed: list && plainBlob(list) ? parseManifest(blob(root, list.oid).toString('utf8')) : null,
        rebuilt: rebuilt.files.includes(MANIFEST) ? parseManifest(readFileSync(join(root, MANIFEST), 'utf8')) : null,
    }
    const listDifferences = !lists.committed || !lists.rebuilt
        ? [`${MANIFEST} is missing ${lists.committed ? 'from the rebuild' : 'from the commit'}`]
        : [...new Set([...lists.committed.keys(), ...lists.rebuilt.keys()])].sort()
            .filter(file => lists.committed.get(file) !== lists.rebuilt.get(file))
            .map(file => `${shown(file)}: committed ${lists.committed.get(file) ?? 'none'}, rebuilt ${lists.rebuilt.get(file) ?? 'none'}`)
    return { files, odd, listDifferences, same: files.every(file => file.same) && odd.length === 0 && listDifferences.length === 0 }
}

/** A pax header's records as npm pack writes them, for a long name: each "<length> <key>=<value>\n", in printable ASCII,
 * of a key that says where a file goes, how long it is or when it changed. node-tar (npm's tar reader) leaves out a
 * record it finds wrong and applies more keys than these (a type, a link), so it would take an entry otherwise: any
 * other record fails. */
function paxRecords (data, fail) {
    const text = data.toString('latin1')
    if (!/^[\x20-\x7e\n]*\n$/.test(text)) {
        fail('is a pax header of other than lines of printable ASCII')
    }
    const records = {}
    for (const line of text.slice(0, -1).split('\n')) {
        const record = /^([1-9][0-9]*) ([^=]+)=(.*)$/.exec(line)
        if (!record || Number(record[1]) !== line.length + 1) {
            fail(`has a pax record that is not one (${shown(line)})`)
        }
        const [, , key, value] = record
        if (!['path', 'size', 'mtime', 'atime', 'ctime'].includes(key) || key in records) {
            fail(`has a pax record npm pack doesn't write (${shown(key)})`)
        }
        if (key === 'size' && !/^[0-9]+$/.test(value) || key === 'path' && value === '') {
            fail(`has a pax ${key} that is not one`)
        }
        records[key] = value
    }
    return records
}

/** The tar in a .tgz as npm pack writes it: one gzip member, its header the ten bytes without a name, comment or extra
 * field, that ends where the file does. Readers differ on what follows a member. Node's gunzip reads a member that
 * comes right after it, and stops at a zero byte, leaving the rest unread; npm's reader (node-tar, fed the package in
 * pieces as it comes) starts again at the next piece, so a member there, after zero bytes, is unpacked too. Bytes after
 * the member could hold files that npm installs and this check never sees, so a file with any fails. */
function unzipped (file) {
    const raw = readFileSync(file)
    const limit = { maxOutputLength: 256 * 1024 * 1024 }
    try {
        if (!raw.subarray(0, 4).equals(Buffer.from([0x1f, 0x8b, 8, 0]))) {
            throw new Error('not gzip as npm pack writes it (a ten-byte header, without a name, comment or extra field)')
        }
        // Where the member's compressed data ends: inflate stops there, and bytesWritten is the input it took. The
        // member's CRC and length (8 bytes) follow it.
        const { engine } = inflateRawSync(raw.subarray(10), { ...limit, info: true })
        const after = raw.length - (10 + engine.bytesWritten + 8)
        if (after > 0) {
            throw new Error(`${after} bytes after its gzip member, which npm pack doesn't write and npm's reader can unpack`)
        }
        // That member alone, its CRC and length checked as npm's reader checks them (gunzip fails a member cut short).
        return gunzipSync(raw, limit)
    } catch (e) {
        throw new Error(e instanceof RangeError ? `${file}: more than 256 MB unpacked, not a package npm pack made` : `${file}: ${e.message}`)
    }
}

/** A .tgz's entries (path, tar type and data), read here rather than unpacked, so that whatever it holds shows: a
 * link, a name outside package/, the same name twice. At most 256 MB unpacked (the package is a few): a package
 * checked before approving it is untrusted until then. Only the plain tar npm pack writes is read, in the one gzip
 * member it writes (see unzipped): ustar headers whose fields hold nothing after their end, a pax header ahead of one
 * for a long name, and the end, empty blocks. Tar readers differ outside that. node-tar, which installs the package,
 * skips a header it finds wrong (a file with a link target, say) and reads that entry's data as the next headers, takes
 * a folder's data, or a file's whose name ends in a slash (in the header or in a pax header), for none, and reads on
 * past a single empty block: a reader that steps over that data shows other files than npm installs. A pax header
 * with no entry after it, an archive without its empty blocks, or a part of a block after the last one are none of
 * what npm pack writes either, and readers differ on them. So a tarball outside it fails here. */
export function readTarball (file) {
    const tar = unzipped(file)
    const entries = []
    let pax = null
    let ended = false
    let at = 0
    while (at + 512 <= tar.length) {
        const header = tar.subarray(at, at + 512)
        const fail = what => {
            throw new Error(`${file}: the tar header at byte ${at} ${what}: npm pack writes none such, and tar readers differ on it`)
        }
        if (header.every(byte => byte === 0)) {
            // The end. node-tar takes one empty block for the end only when a second follows, and reads on otherwise,
            // so anything after the first would be installed without having been checked: only zeros.
            if (!tar.subarray(at).every(byte => byte === 0)) {
                throw new Error(`${file}: more after the end of the archive (byte ${at}), which npm would unpack too`)
            }
            // Two empty blocks at least, and whole ones: npm pack writes two, padded to a whole record.
            if (tar.length - at < 1024 || (tar.length - at) % 512 !== 0) {
                throw new Error(`${file}: its end is ${tar.length - at} bytes of zeros, not the two or more whole empty blocks npm pack ` +
                    'writes, and tar readers differ on it')
            }
            ended = true
            break
        }
        // A field's text, the same for every reader: up to a NUL, and nothing but NULs after that one.
        const text = (start, length) => {
            const raw = header.subarray(start, start + length)
            const end = raw.includes(0) ? raw.indexOf(0) : length
            if (raw.subarray(end).some(byte => byte !== 0)) {
                fail(`has more in a field (byte ${start}) after its end`)
            }
            return raw.subarray(0, end).toString('utf8')
        }
        // The checksum's field as tar writes it: up to seven octal digits, then spaces or NULs.
        const checksum = /^([0-7]{1,7})[ \0]+$/.exec(header.subarray(148, 156).toString('latin1'))
        if (!checksum || parseInt(checksum[1], 8) !== header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 0x20 : byte), 0)) {
            fail('is damaged (its checksum)')
        }
        if (header.subarray(257, 265).toString('latin1') !== 'ustar\u000000') {
            fail("hasn't ustar's magic and version")
        }
        const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
        const digits = /^([0-7]+) *$/.exec(text(124, 12))
        if (!digits) {
            fail('has a size that is not one')
        }
        let size = parseInt(digits[1], 8)
        const name = text(0, 100)
        const link = text(157, 100)
        const prefix = text(345, 155)
        if (type === 'x') {
            if (pax) {
                fail('is a second pax header in a row')
            }
            if (size > 64 * 1024) {
                fail('is a pax header of more than 64 KB')
            }
        } else if (!['0', '5', '1', '2'].includes(type)) {
            fail(`is of a kind that isn't a file, a folder or a link (tar type ${shown(type)})`)
        } else {
            if (pax?.path !== undefined && prefix !== '') {
                fail('has a ustar prefix besides a pax name')
            }
            if (pax?.size !== undefined) {
                size = Number(pax.size)
            }
            if ((type === '0' || type === '5') && link !== '') {
                fail('names a link target for what is no link')
            }
            if (type === '5' && size !== 0) {
                fail('is a folder with data')
            }
        }
        if (!Number.isSafeInteger(size) || at + 512 + size > tar.length) {
            fail('has a size past the end of the archive')
        }
        const data = tar.subarray(at + 512, at + 512 + size)
        if (type === 'x') {
            pax = paxRecords(data, fail)
        } else {
            // The name in the ustar header too, which a pax name can hide the slash of.
            const written = prefix === '' ? name : `${prefix}/${name}`
            const path = pax?.path ?? written
            if (path === '') {
                fail('names nothing')
            }
            if (type === '0' && (path.endsWith('/') || written.endsWith('/'))) {
                fail('is a file whose name ends in a slash, a folder to node-tar')
            }
            entries.push({ path, type, data })
            pax = null
        }
        at += 512 + Math.ceil(size / 512) * 512
    }
    if (!ended) {
        throw new Error(`${file}: ${at < tar.length ? `${tar.length - at} bytes after its last entry, less than a block` : 'no empty blocks at its end'}: ` +
            'npm pack writes neither, and tar readers differ on it')
    }
    if (pax) {
        throw new Error(`${file}: a pax header with no entry after it: npm pack writes none such, and tar readers differ on it`)
    }
    return entries
}

/** A package's files (path in the package → data), and what is wrong with its entries in itself. npm unpacks a
 * package's first folder in place, whatever it is called, and leaves links out (npm 11's pacote drops them as it
 * unpacks); neither a renamed folder nor a link is in what npm pack writes, nor is a folder entry (it writes files
 * only), so any of them is a problem here, as are a name twice and two names one disk that ignores case would take
 * for one. A folder entry is no file to check, but an extractor makes a folder at its path, where the package has a
 * file (a required one, say) or not. */
export function packageFiles (tarball, problems) {
    const files = new Map()
    const folded = new Map()
    for (const entry of readTarball(tarball)) {
        if (entry.type === '5') {
            problems.push(`${shown(entry.path)} in ${tarball}: a folder, which npm pack doesn't write and an extractor makes at that path`)
            continue
        }
        const parts = entry.path.split('/')
        if (parts[0] !== 'package' || parts.length < 2 || parts.some(part => part === '' || part === '.' || part === '..') || entry.path.includes('\\')) {
            problems.push(`${shown(entry.path)} in ${tarball}: not a file in the package's folder`)
            continue
        }
        const file = parts.slice(1).join('/')
        if (entry.type !== '0') {
            problems.push(`${shown(file)} in ${tarball}: not a plain file (tar type ${shown(entry.type)})`)
            continue
        }
        if (files.has(file)) {
            problems.push(`${shown(file)} in ${tarball}: in it twice`)
        }
        const key = file.normalize('NFC').toLowerCase()
        if (folded.has(key) && folded.get(key) !== file) {
            problems.push(`${shown(file)} and ${shown(folded.get(key))} in ${tarball}: one file on a disk that ignores case`)
        }
        folded.set(key, file)
        files.set(file, entry.data)
    }
    return files
}

/** A package against a revision of the repository at root: vendor/ as that revision's vendor/SHA256SUMS lists it, and
 * every other file outside dist/ as in that revision; with sameAs, every file against that package's too. The list
 * read is the repository's, never the package's own copy, which could only vouch for itself. */
export function checkPackage (root, tarball, { revision, sameAs } = {}) {
    const problems = []
    const files = packageFiles(tarball, problems)
    let version = null
    try {
        version = JSON.parse(files.get('package.json')?.toString('utf8') ?? 'null')?.version ?? null
    } catch {
        problems.push(`package.json in ${tarball}: not JSON`)
    }
    if (!revision) {
        if (!version) {
            throw new Error(`${tarball} has no version to find its tag by: name the revision to check it against`)
        }
        revision = `v${version}`
    }
    let commit
    try {
        commit = git(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).toString('utf8').trim()
    } catch {
        throw new Error(`${revision} is not in this repository (git fetch --tags), or not a commit`)
    }
    const committed = tree(root, commit)
    const format = git(root, ['rev-parse', '--show-object-format']).toString('utf8').trim()
    const blobId = data => createHash(format).update(`blob ${data.length}\0`).update(data).digest('hex')

    let built = 0
    for (const [file, data] of files) {
        if (file.startsWith('dist/')) {
            built++
            continue
        }
        const entry = committed.get(file)
        if (!entry || !plainBlob(entry)) {
            problems.push(`${shown(file)}: not a file in ${revision}`)
        } else if (entry.oid !== blobId(data)) {
            problems.push(`${shown(file)}: not as in ${revision}`)
        }
    }

    const list = committed.get(MANIFEST)
    if (!list || !plainBlob(list)) {
        throw new Error(`${revision} has no ${MANIFEST}`)
    }
    const sums = parseManifest(blob(root, list.oid).toString('utf8'))
    const listed = [...sums.keys()].filter(file => file.startsWith('vendor/'))
    for (const file of listed) {
        if (!files.has(file)) {
            problems.push(`${shown(file)}: missing from the package`)
        } else if (sha256(files.get(file)) !== sums.get(file)) {
            problems.push(`${shown(file)}: not what ${revision}'s ${MANIFEST} records`)
        }
    }
    for (const file of files.keys()) {
        if (file.startsWith('vendor/') && file !== MANIFEST && !sums.has(file)) {
            problems.push(`${shown(file)}: not in ${revision}'s ${MANIFEST}`)
        }
    }
    if (!files.has(MANIFEST)) {
        problems.push(`${MANIFEST}: missing from the package`)
    }

    if (sameAs) {
        const other = packageFiles(sameAs, problems)
        for (const file of [...new Set([...files.keys(), ...other.keys()])].sort()) {
            if (!other.has(file)) {
                problems.push(`${shown(file)}: not in ${sameAs}`)
            } else if (!files.has(file)) {
                problems.push(`${shown(file)}: only in ${sameAs}`)
            } else if (!files.get(file).equals(other.get(file))) {
                problems.push(`${shown(file)}: not as in ${sameAs}`)
            }
        }
    }
    return { problems, revision, commit, version, files: files.size, vendor: listed.length, built }
}

/** Whether ironrdp/BASE_COMMIT is in IronRDP's own history: an ancestor of its master branch. GitHub serves a commit
 * from any fork of a repository through the repository's own address, so that the build could fetch it says nothing.
 * master's history (its commits, no files) is fetched into a scratch repository. */
export function checkBase (root, { upstream = UPSTREAM, branch = 'master' } = {}) {
    const commit = readFileSync(join(root, 'ironrdp/BASE_COMMIT'), 'utf8').trim()
    if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new Error(`ironrdp/BASE_COMMIT is not a commit: ${shown(commit)}`)
    }
    const scratch = mkdtempSync(join(tmpdir(), 'ironrdp-history-'))
    try {
        git(scratch, ['init', '-q'])
        try {
            git(scratch, ['fetch', '-q', '--filter=tree:0', upstream, branch])
        } catch (e) {
            // Offline, say: then the commit can't be checked, and the build doesn't go on unchecked.
            throw new Error(`ironrdp/BASE_COMMIT can't be checked: IronRDP's history (${upstream}, ${branch}) didn't come: ${String(e.stderr || e.message).trim()}`)
        }
        try {
            // A commit master's history doesn't have is fetched on its own to be looked at (exit 1), or isn't there
            // at all (exit 128): either way, not IronRDP's.
            git(scratch, ['merge-base', '--is-ancestor', commit, 'FETCH_HEAD'])
            return { commit, upstream: true }
        } catch {
            return { commit, upstream: false }
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}

function main (args) {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const error = message => {
        console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : message)
        process.exitCode = 1
    }
    const [command, ...rest] = args
    const usage = 'usage: node scripts/check-vendor.mjs base | rebuilt | package <package.tgz> [<revision>] [--same-as <package.tgz>]'
    if (command === 'base' && rest.length === 0) {
        const { commit, upstream } = checkBase(root)
        if (!upstream) {
            return error(`ironrdp/BASE_COMMIT (${commit}) is not in IronRDP's history (${UPSTREAM}, master): a commit from a fork, or none at all. vendor/ is built from IronRDP's own commits only.`)
        }
        console.log(`IronRDP ${commit} is in ${UPSTREAM}'s history (master).`)
    } else if (command === 'rebuilt' && rest.length === 0) {
        const result = compareRebuilt(root)
        const base = readFileSync(join(root, 'ironrdp/BASE_COMMIT'), 'utf8').trim()
        const patches = readdirSync(join(root, 'ironrdp/patches')).filter(name => name.endsWith('.patch') && !name.startsWith('.')).length
        const summary = [`### vendor/ rebuilt from IronRDP ${base} and ${patches} patches`, '', '| File | Committed (SHA-256) | Rebuilt (SHA-256) | |', '|---|---|---|---|']
        for (const file of result.files) {
            const verdict = file.same ? 'same' : 'DIFFERENT'
            console.log(`${shown(file.file)}: ${verdict}\n  committed ${file.committed ?? 'none'}\n  rebuilt   ${file.rebuilt ?? 'none'}`)
            summary.push(`| \`${shown(file.file)}\` | \`${file.committed ?? 'none'}\` | \`${file.rebuilt ?? 'none'}\` | ${verdict} |`)
        }
        for (const line of [...result.odd.map(odd => `${odd}: not a plain file`), ...result.listDifferences.map(difference => `${MANIFEST}, ${difference}`)]) {
            console.log(line)
            summary.push('', `- ${line}`)
        }
        summary.push('', result.same ? 'vendor/ is byte for byte what the series builds to.' : '**vendor/ is not what the series builds to.**', '')
        if (process.env.GITHUB_STEP_SUMMARY) {
            appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n'))
        }
        if (!result.same) {
            return error('vendor/ is not what IronRDP and ironrdp/patches build to here. The rebuilt files are attached to this run (vendor-rebuilt); ironrdp/README.md, "Reproducing vendor/", says what to do.')
        }
        console.log('vendor/ is byte for byte what the series builds to.')
    } else if (command === 'package' && rest.length >= 1) {
        const options = {}
        const positional = []
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === '--same-as' && i + 1 < rest.length) {
                options.sameAs = rest[++i]
            } else if (rest[i].startsWith('-')) {
                // Not a revision to look up: git would take it for an option of its own.
                return error(usage)
            } else {
                positional.push(rest[i])
            }
        }
        if (positional.length < 1 || positional.length > 2) {
            return error(usage)
        }
        const [tarball, revision] = positional
        const result = checkPackage(root, resolve(tarball), { revision, sameAs: options.sameAs && resolve(options.sameAs) })
        console.log(`${tarball} (version ${result.version ?? 'unknown'}) against ${result.revision} (${result.commit}):`)
        if (result.problems.length > 0) {
            for (const problem of result.problems) {
                console.log(`  ${problem}`)
            }
            return error(`${tarball} is not ${result.revision}'s package: ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'} (above).`)
        }
        console.log(`  vendor/: the ${result.vendor} files ${result.revision}'s ${MANIFEST} lists, as it records them, and nothing else`)
        console.log(`  the other ${result.files - result.vendor - result.built} files outside dist/: as in ${result.revision}`)
        console.log(options.sameAs
            ? `  dist/ and everything else: as in ${options.sameAs}`
            : `  dist/: ${result.built} files, built, so not compared (--same-as <a package built from ${result.revision}> compares them)`)
    } else {
        return error(usage)
    }
}

// Run as a command, not when the tests import it. Through real paths: on a Mac, /tmp is a link to /private/tmp.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    try {
        main(process.argv.slice(2))
    } catch (e) {
        console.error(process.env.GITHUB_ACTIONS ? `::error::${e.message}` : e.message)
        process.exitCode = 1
    }
}
