// Build the test-only peer after the pinned native build. Does not replace or re-record the production bundle.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (file, args) => execFileSync(file, args, { cwd: root, stdio: 'inherit' })
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
const build = path.join(root, '.qa/freerdp-build/build')
run('cmake', ['-S', path.join(root, 'native'), '-B', build,
    `-DCMAKE_PROJECT_tabby_freerdp_INCLUDE=${path.join(root, 'test/fixtures/pam/build.cmake')}`])
run('cmake', ['--build', build, '--config', 'Release', '--target', 'tabby-pam-test-server'])
fs.mkdirSync(path.join(root, 'native-artifacts'), { recursive: true })
const name = `tabby-pam-test-server${process.platform === 'win32' ? '.exe' : ''}`
fs.copyFileSync(path.join(build, name), path.join(root, 'native-artifacts', name))
