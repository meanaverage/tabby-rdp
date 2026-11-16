// Explicit build only. The plugin never downloads or compiles code at runtime.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pins = JSON.parse(readFileSync(join(root, 'native/wasm-source.json')))
const freerdp = JSON.parse(readFileSync(join(root, 'native/freerdp-source.json')))
const work = join(root, '.qa/freerdp-wasm'), prefix = join(work, 'install')
const emsdk = resolve(process.env.EMSDK || join(root, '.qa/emsdk'))
const emcmake = join(emsdk, 'upstream/emscripten/emcmake')
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options })
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const version = execFileSync(join(emsdk, 'upstream/emscripten/emcc'), ['--version'], { encoding: 'utf8' })
if (!version.split('\n')[0].includes(` ${pins.emscripten} (`)) throw new Error(`Use Emscripten ${pins.emscripten}`)
mkdirSync(work, { recursive: true })
async function source(name, pin, archiveName) {
    const archive = join(work, archiveName)
    if (!existsSync(archive)) {
        const response = await fetch(pin.url)
        if (!response.ok) throw new Error(`Download failed: ${name} (${response.status})`)
        writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
    }
    if (hash(archive) !== pin.sha256) throw new Error(`Source checksum mismatch: ${name}`)
    const destination = join(work, name)
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    run('tar', ['xf', archive, '--strip-components=1', '-C', destination])
    return destination
}
const configure = (name, source, args) => {
    const build = join(work, `build-${name}`)
    run(emcmake, ['cmake', '-S', source, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
        `-DCMAKE_INSTALL_PREFIX=${prefix}`, `-DCMAKE_PREFIX_PATH=${prefix}`, `-DCMAKE_FIND_ROOT_PATH=${prefix}`,
        '-DCMAKE_C_FLAGS=-pthread', '-DCMAKE_CXX_FLAGS=-pthread', '-DCMAKE_EXE_LINKER_FLAGS=-pthread',
        '-DBUILD_SHARED_LIBS=OFF', ...args])
    run('cmake', ['--build', build, '--parallel', '8', ...(name === 'freerdp' ? ['--target', 'tabby-freerdp'] : [])])
    if (name !== 'freerdp') run('cmake', ['--install', build])
    return build
}
const ssl = await source('libressl', pins.libressl, `libressl-${pins.libressl.version}.tar.gz`)
configure('libressl', ssl, ['-DLIBRESSL_APPS=OFF', '-DLIBRESSL_TESTS=OFF'])
const zlib = await source('zlib', pins.zlib, `zlib-${pins.zlib.version}.tar.gz`)
configure('zlib', zlib, ['-DZLIB_BUILD_SHARED=OFF', '-DZLIB_BUILD_TESTING=OFF'])
const sourceDir = await source('freerdp', freerdp, `freerdp-${freerdp.version}.tar.gz`)
const build = configure('freerdp', join(root, 'native'), [`-DFREERDP_SOURCE_DIR=${sourceDir}`, `-DOPENSSL_ROOT_DIR=${prefix}`])
const destination = join(root, 'wasm/freerdp')
mkdirSync(join(destination, 'licenses'), { recursive: true })
for (const file of ['tabby-freerdp.js', 'tabby-freerdp.wasm']) copyFileSync(join(build, file), join(destination, file))
copyFileSync(join(emsdk, 'upstream/emscripten/LICENSE'), join(destination, 'licenses/Emscripten-LICENSE'))
copyFileSync(join(sourceDir, 'LICENSE'), join(destination, 'licenses/FreeRDP-LICENSE'))
copyFileSync(join(ssl, 'COPYING'), join(destination, 'licenses/LibreSSL-LICENSE'))
copyFileSync(join(zlib, 'LICENSE'), join(destination, 'licenses/zlib-LICENSE'))
copyFileSync(join(sourceDir, 'winpr/libwinpr/sysinfo/cpufeatures/NOTICE'), join(destination, 'licenses/FreeRDP-NOTICE'))
const unicode = readFileSync(join(sourceDir, 'winpr/libwinpr/crt/unicode_builtin.c'), 'utf8').match(/^\/\*[\s\S]*?\*\//)?.[0]
if (!unicode?.includes('Unicode, Inc.')) throw new Error('Review the Unicode license')
writeFileSync(join(destination, 'licenses/Unicode-NOTICE'), unicode + '\n')
const sources = ['native/main.c', 'native/wasm-io.h', 'native/options.cmake', 'native/CMakeLists.txt', 'native/wasm-source.json', 'scripts/build-freerdp-wasm.mjs']
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])
writeFileSync(join(destination, 'BUILD.json'), JSON.stringify({ freerdp, toolchain: pins, buildSources: Object.fromEntries(sources.map(p => [p, hash(join(root, p))])),
    files: files(destination).filter(p => !p.endsWith('BUILD.json')).map(p => ({ path: p.slice(destination.length + 1), sha256: hash(p) })) }, null, 2) + '\n')
console.log(`Built FreeRDP ${freerdp.version} WebAssembly in ${destination}`)
