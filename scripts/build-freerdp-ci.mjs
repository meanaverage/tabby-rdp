// Native Windows/Linux builds use the same reviewed OpenSSL source on every architecture.
// Run on the target architecture, with CMake, Perl and the platform compiler installed.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'native/openssl-source.json')))
const target = `${process.platform}-${process.arch}`
const configurations = { 'linux-x64': 'linux-x86_64', 'linux-arm64': 'linux-aarch64', 'win32-x64': 'VC-WIN64A', 'win32-arm64': 'VC-WIN64-ARM' }
if (!configurations[target]) throw new Error(`Unsupported native build: ${target}`)
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: 'inherit' })
if (process.platform === 'win32') {
    const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe')
    const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.ARM64', '-property', 'installationPath'], { encoding: 'utf8' }).trim() ||
        execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim()
    if (!installation) throw new Error('Visual Studio C++ build tools were not found')
    const vars = path.join(installation, 'VC/Auxiliary/Build/vcvarsall.bat')
    const environment = execFileSync('cmd.exe', ['/d', '/s', '/c', `""${vars}" ${process.arch === 'arm64' ? 'arm64' : 'amd64'} >nul && set"`], { encoding: 'utf8', windowsVerbatimArguments: true })
    for (const line of environment.split(/\r?\n/)) {
        const at = line.indexOf('=')
        if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1)
    }
}
const work = path.join(root, '.qa/openssl-build', target)
const source = path.join(work, `openssl-${manifest.version}`)
const prefix = path.join(work, 'install')
const archive = path.join(work, `openssl-${manifest.version}.tar.gz`)
fs.mkdirSync(work, { recursive: true })
if (!fs.existsSync(archive)) {
    const response = await fetch(manifest.url)
    if (!response.ok) throw new Error(`OpenSSL source download failed (${response.status})`)
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
}
if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== manifest.sha256) throw new Error('OpenSSL source checksum mismatch')
fs.rmSync(source, { recursive: true, force: true })
fs.rmSync(prefix, { recursive: true, force: true })
run('cmake', ['-E', 'tar', 'xzf', archive], work)
// Each source tree is fresh: dependency scanning would compile every MSVC source twice without helping rebuilds.
run('perl', ['Configure', configurations[target], `--prefix=${prefix}`, `--openssldir=${path.join(prefix, 'ssl')}`, '--libdir=lib', 'shared', 'no-tests', 'no-makedepend', ...process.platform === 'win32' ? ['no-asm'] : []], source)
if (process.platform === 'win32') {
    run('nmake', [], source)
    run('nmake', ['install_sw'], source)
} else {
    run('make', ['-j', String(Math.min(8, os.availableParallelism()))], source)
    run('make', ['install_sw'], source)
}
fs.copyFileSync(path.join(source, 'LICENSE.txt'), path.join(prefix, 'LICENSE.txt'))
fs.writeFileSync(path.join(prefix, 'tabby-source.json'), JSON.stringify(manifest, null, 2) + '\n')
run(process.execPath, [path.join(root, 'scripts/build-freerdp.mjs'), '--openssl-prefix', prefix, '-DTRD_BUILD_TESTS=ON', ...process.platform === 'win32' ? ['-G', 'Ninja'] : []], root)
run('cmake', ['--build', path.join(root, '.qa/freerdp-build/build'), '--config', 'Release', '--target', 'tabby-clipboard-test'], root)
// The callback executable uses the same staged DLLs as the helper on Windows.
process.env.PATH = path.join(root, 'native/bin', target) + path.delimiter + process.env.PATH
run('ctest', ['--test-dir', path.join(root, '.qa/freerdp-build/build'), '-C', 'Release', '--output-on-failure'], root)
// Uploading loose files would discard Linux executable modes. Keep the bundle in a tar archive.
run('cmake', ['-E', 'tar', 'czf', path.join(root, '.qa', `freerdp-${target}.tgz`), `native/bin/${target}`], root)
