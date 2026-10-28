#!/usr/bin/env node
// Builds the network helper (helper/, Go, standard library only) into bin/<platform>-<arch>/: for this computer
// (`npm run build:helper`, for development and the tests), or for every platform the package ships (`--all`, what
// CI and a release pack). Installing the plugin needs neither Go nor a download: npm unpacks these files as they are,
// executable.
//
// The builds are reproducible: no cgo, paths and the build id left out, the plugin's version as the only thing set
// from outside, and exactly the Go toolchain helper/go.mod names (a release build refuses another). So the same
// commit gives the same files on any machine, and CI builds them on two systems and compares them (ci.yml); bin/
// SHA256SUMS lists them as built.
//
//   node scripts/build-helper.mjs [--all] [--check]
//       --all: every target in TARGETS (otherwise only this computer's)
//       --check: refuse any Go but go.mod's toolchain (implied by --all)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** What the package ships: Node's platform and arch, and Go's names for them. Tabby's own releases are these. */
export const TARGETS = [
    { platform: 'darwin', arch: 'arm64', goos: 'darwin', goarch: 'arm64' },
    { platform: 'darwin', arch: 'x64', goos: 'darwin', goarch: 'amd64' },
    { platform: 'linux', arch: 'x64', goos: 'linux', goarch: 'amd64' },
    { platform: 'linux', arch: 'arm64', goos: 'linux', goarch: 'arm64' },
    { platform: 'linux', arch: 'arm', goos: 'linux', goarch: 'arm', goarm: '7' },
    { platform: 'win32', arch: 'x64', goos: 'windows', goarch: 'amd64' },
    { platform: 'win32', arch: 'arm64', goos: 'windows', goarch: 'arm64' },
]

/** A target's helper, as a path in the package. */
export function helperFile ({ platform, arch }) {
    return `bin/${platform}-${arch}/tabby-rdp-proxy${platform === 'win32' ? '.exe' : ''}`
}

/** The list of the helpers' hashes, as a path in the package. */
export const SUMS = 'bin/SHA256SUMS'

/** The Go toolchain helper/go.mod names (`toolchain goX.Y.Z`). */
export function wantedToolchain (root) {
    const mod = fs.readFileSync(path.join(root, 'helper/go.mod'), 'utf8')
    const m = /^toolchain (go\d+\.\d+(?:\.\d+)?)\s*$/m.exec(mod)
    if (!m) {
        throw new Error('helper/go.mod names no toolchain')
    }
    return m[1]
}

function main (args) {
    const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
    const all = args.includes('--all')
    const check = all || args.includes('--check')
    for (const arg of args) {
        if (!['--all', '--check'].includes(arg)) {
            throw new Error(`Unknown argument: ${arg}`)
        }
    }
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
    // Nothing from the environment changes what is built, but where Go is and where it keeps its cache.
    const env = {}
    for (const name of ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'GOCACHE', 'GOPATH', 'GOROOT', 'GOMODCACHE', 'XDG_CACHE_HOME']) {
        if (process.env[name] !== undefined) {
            env[name] = process.env[name]
        }
    }
    // Nor Go's own env file (`go env -w`), which would otherwise set what isn't set here; and the variables that change
    // the code for a target are set to Go's defaults rather than left to it.
    Object.assign(env, {
        CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly', GOPROXY: 'off', GOWORK: 'off', GOENV: 'off',
        GOAMD64: 'v1', GOARM64: 'v8.0', GO386: 'sse2', GOEXPERIMENT: '', GOFIPS140: 'off',
    })
    const go = (goArgs, extra = {}) => execFileSync('go', goArgs, { cwd: path.join(root, 'helper'), env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    const have = go(['env', 'GOVERSION']).trim()
    const wanted = wantedToolchain(root)
    if (have !== wanted) {
        const message = `Go ${have} is not helper/go.mod's toolchain (${wanted}): the helpers would differ from a release's`
        if (check) {
            throw new Error(`${message}. Install ${wanted}, or run with GOTOOLCHAIN=${wanted} to have go fetch it.`)
        }
        console.warn(`warning: ${message}`)
    }
    const targets = all ? TARGETS : TARGETS.filter(t => t.platform === process.platform && t.arch === process.arch)
    if (!targets.length) {
        throw new Error(`The package ships no helper for ${process.platform}-${process.arch}`)
    }
    if (all) {
        fs.rmSync(path.join(root, 'bin'), { recursive: true, force: true })
    }
    const sums = []
    for (const target of targets) {
        const file = helperFile(target)
        const out = path.join(root, file)
        fs.mkdirSync(path.dirname(out), { recursive: true })
        go(['build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -buildid= -X main.version=${version}`, '-o', out, '.'], {
            GOOS: target.goos, GOARCH: target.goarch, ...target.goarm ? { GOARM: target.goarm } : {},
        })
        fs.chmodSync(out, 0o755)
        const sum = createHash('sha256').update(fs.readFileSync(out)).digest('hex')
        sums.push(`${sum}  ${file}`)
        console.log(`${file}  ${sum}`)
    }
    if (all) {
        fs.writeFileSync(path.join(root, SUMS), `# The network helpers, built from helper/ with ${have} by scripts/build-helper.mjs (tabby-rdp ${version}).\n${sums.join('\n')}\n`)
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    try {
        main(process.argv.slice(2))
    } catch (e) {
        console.error(process.env.GITHUB_ACTIONS ? `::error::${e.message}` : e.message)
        process.exitCode = 1
    }
}
