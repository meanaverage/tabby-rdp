// Run on a dedicated client VM. This owns a disposable native Tabby profile; CDP must remain private.
// node scripts/qa/client.mjs <Tabby executable> <plugin bundle directory> <loopback CDP port>
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const [binary, bundle, port] = process.argv.slice(2)
if (!binary || !bundle || !/^[1-9]\d{0,4}$/.test(port || '') || Number(port) > 65535) throw new Error('Expected Tabby executable, plugin bundle directory and CDP port')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-visual-client-'))
const modules = path.join(profile, 'plugins/node_modules')
fs.mkdirSync(modules, { recursive: true })
fs.writeFileSync(path.join(profile, 'config.yaml'), [
    'enableWelcomeTab: false',
    'enableAnalytics: false',
    'recoverTabs: false',
    'enableAutomaticUpdates: false',
    // The portable Windows host can retain an obsolete shell profile; avoid opening it at startup.
    ...(process.platform === 'win32' ? ['terminal:', '  profile: local:cmd', '  autoOpen: false'] : []),
    'remoteDesktop:',
    '  tipShown: true',
    '  checkUpdates: false',
    '',
].join('\n'))
fs.writeFileSync(path.join(profile, 'plugins/package.json'), '{}')
fs.cpSync(path.resolve(bundle), path.join(modules, 'tabby-rdp'), { recursive: true })
const guard = path.join(modules, 'tabby-aaa-smoke-credentials')
fs.mkdirSync(guard)
fs.writeFileSync(path.join(guard, 'package.json'), JSON.stringify({ name: 'tabby-aaa-smoke-credentials', version: '1.0.0', author: 'tabby-rdp tests', main: 'index.js', keywords: ['tabby-plugin'] }))
fs.copyFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/smoke-credentials.cjs'), path.join(guard, 'index.js'))
const child = spawn(binary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { env: { ...process.env, TABBY_CONFIG_DIRECTORY: profile }, stdio: 'inherit', detached: process.platform !== 'win32' })
let closed = false
function cleanup () {
    if (closed) return
    closed = true
    if (child.pid) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
        else { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(0) })
process.on('exit', cleanup)
child.on('error', error => { console.error(error); process.exit(1) })
child.on('exit', code => { cleanup(); process.exit(code || 0) })
console.log(`Dedicated ${process.platform}/${process.arch} Tabby client; CDP port ${port}; profile ${profile}`)
