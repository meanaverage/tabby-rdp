#!/usr/bin/env node
// Stage npm's selected files, replace only the deterministic metadata files (package.json; format 1 also its shrinkwrap),
// and pack with lifecycle scripts disabled. The source checkout is never mutated. Format 4 also packs each platform's
// FreeRDP package from native/bin (scripts/package-metadata.mjs). Prints each package's file name, the plugin's first;
// with --dry-run, each package as "# <name>@<version>" and then its files.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { freeRDPFiles, freeRDPMetadata, freeRDPPlatforms, runtimeMetadata } from './package-metadata.mjs'
import { helperFile, SUMS, TARGETS } from './build-helper.mjs'
import { npmCommand } from './npm-command.mjs'
const npm = npmCommand()

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
let destination = process.cwd()
let dryRun = false
const args = process.argv.slice(2)
while (args.length) {
    const arg = args.shift()
    if (arg === '--pack-destination' && args.length) destination = path.resolve(args.shift())
    else if (arg === '--dry-run') dryRun = true
    else throw new Error(`Unknown or incomplete pack argument: ${arg}`)
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const format = manifest.tabbyRdp?.packageFormat
// The committed lock: format 1's shrinkwrap (published, projected), later formats' package-lock.json (never published).
const lockFile = format === 1 ? 'npm-shrinkwrap.json' : 'package-lock.json'
const metadata = runtimeMetadata(manifest, JSON.parse(fs.readFileSync(path.join(root, lockFile), 'utf8')))
if (format >= 5) {
    for (const file of [SUMS, ...TARGETS.map(helperFile)]) {
        if (!fs.existsSync(path.join(root, file))) {
            throw new Error(`${file} is missing: npm run build:helpers builds the network helpers`)
        }
    }
}
fs.mkdirSync(destination, { recursive: true })

/** Copies a checkout's file into a stage. Executable helpers stay executable: writeFileSync's default mode would make
 * the native RDP client non-executable in the tarball even though it works from the source checkout. */
function stageFile (stage, name, source, data) {
    const target = path.join(stage, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data ?? fs.readFileSync(source), { mode: fs.statSync(source).mode & 0o777 })
}

/** Packs a stage: prints the package's file name, or its name, version and files. With `expected`, npm has to pack
 * those files and no others (it leaves some names out of any package, whatever is staged). */
function pack (stage, expected) {
    const [packed] = JSON.parse(execFileSync(npm.file, [...npm.args, 'pack', '--ignore-scripts', '--json',
        '--pack-destination', destination, ...(dryRun ? ['--dry-run'] : [])],
    { cwd: stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
    const files = packed.files.map(file => file.path).sort()
    if (expected && JSON.stringify(files) !== JSON.stringify([...expected].sort())) {
        throw new Error(`npm packed other files than staged for ${packed.name}: ${files.join(', ')}`)
    }
    if (dryRun) {
        console.log(`# ${packed.name}@${packed.version}`)
        for (const file of files) console.log(` ${file}`)
    } else {
        console.log(packed.filename)
    }
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-rdp-package-'))
try {
    const [selection] = JSON.parse(execFileSync(npm.file, [...npm.args, 'pack', '--dry-run', '--ignore-scripts', '--json'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
    for (const { path: name } of selection.files) {
        const source = path.resolve(root, name)
        if (!source.startsWith(root + path.sep) || !fs.lstatSync(source).isFile()) {
            throw new Error(`Package entry is not a plain file inside the checkout: ${name}`)
        }
        if (format >= 4 && name.startsWith('native/bin/')) {
            throw new Error(`${name}: the FreeRDP helper goes in its platform's package, not the plugin's (package.json's files)`)
        }
        stageFile(stage, name, source, metadata[name])
    }
    for (const [name, data] of Object.entries(metadata)) fs.writeFileSync(path.join(stage, name), data)
    pack(stage)
} finally {
    fs.rmSync(stage, { recursive: true, force: true })
}

for (const platform of format >= 4 ? freeRDPPlatforms(manifest) : []) {
    const built = path.join(root, 'native/bin', platform)
    if (!fs.existsSync(path.join(built, 'BUILD.json'))) {
        throw new Error(`native/bin/${platform}/BUILD.json is missing: build the helper there (native/README.md), or leave ${platform} out of tabbyRdp.freerdpPlatforms`)
    }
    // What the build made, as its record lists and hashed it; nothing else in the folder goes in.
    const record = JSON.parse(fs.readFileSync(path.join(built, 'BUILD.json'), 'utf8'))
    for (const { path: file, sha256 } of record.files) {
        if (typeof file !== 'string' || file.split('/').some(part => part === '' || part === '.' || part === '..') || file.includes('\\')) {
            throw new Error(`native/bin/${platform}/BUILD.json lists a file outside its folder: ${file}`)
        }
        if (createHash('sha256').update(fs.readFileSync(path.join(built, file))).digest('hex') !== sha256) {
            throw new Error(`native/bin/${platform}/${file} is not what its BUILD.json records: rebuild it, or restore the committed build`)
        }
    }
    const files = freeRDPFiles(platform, ['BUILD.json', ...record.files.map(file => file.path)])
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-rdp-freerdp-package-'))
    try {
        for (const [name, source] of files) stageFile(stage, name, path.join(root, source))
        fs.writeFileSync(path.join(stage, 'package.json'), freeRDPMetadata(manifest, platform))
        pack(stage, ['package.json', ...files.map(([name]) => name)])
    } finally {
        fs.rmSync(stage, { recursive: true, force: true })
    }
}
