// Uses a dedicated Windows account: opens PowerShell/Explorer, replaces its clipboard, creates and removes a
// uniquely named temporary directory. Build the plugin first. No credentials are written to disk or output.
const assert = require('node:assert/strict')
const { connect } = require('node:net')
const { once } = require('node:events')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')
const { createHash } = require('node:crypto')
const { FreeRDPProcess, numbers } = require('../dist/freerdp.js')
const { freeRDPFileProvider } = require('../dist/freerdpFiles.js')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
global.FileReader = class {
    readAsArrayBuffer (blob) { blob.arrayBuffer().then(data => { this.result = data; this.onload?.() }) }
    abort () {}
}
const runtime = process.env.TRD_TEST_FREERDP_RUNTIME === 'wasm' ? 'wasm' : 'native'
const native = new FreeRDPProcess(runtime)
let provider, remoteText = '', fileEvents = []
const prefix = 'tabby-files-' + runtime + '-' + Date.now()
const wait = async (predicate, label, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) { const result = predicate(); if (result) return result; await sleep(100) }
    throw new Error('Timed out: ' + label)
}
const key = (scan, up = false) => native.send('K', numbers(up ? 0x8000 : 0, scan, 0))
const tap = scan => { key(scan); key(scan, true) }
const paste = () => { key(0x1d); tap(0x2f); key(0x1d, true) }
async function run (script) {
    native.sendClipboardText('powershell -NoProfile'); await sleep(400)
    key(0x15b); tap(0x13); key(0x15b, true); await sleep(600)
    paste(); await sleep(400); tap(0x1c); await sleep(2000)
    native.sendClipboardText(script + ';exit'); await sleep(500)
    paste(); await sleep(400); tap(0x1c); await sleep(2000)
}
async function main () {
    const host = process.env.TRD_TEST_DIRECT
    const username = process.env.TRD_TEST_DIRECT_USER
    const password = process.env.TRD_TEST_DIRECT_PASSWORD
    const fingerprint = process.env.TRD_TEST_CERT_SHA256
    const port = Number(process.env.TRD_TEST_DIRECT_PORT || 3389)
    assert.ok(host && username && password && fingerprint, 'Set TRD_TEST_DIRECT (hostname), TRD_TEST_DIRECT_USER, TRD_TEST_DIRECT_PASSWORD and TRD_TEST_CERT_SHA256')
    const { RdpFileTransferProvider } = await import(pathToFileURL(resolve(__dirname, '../vendor/iron-remote-desktop-rdp.js')))
    const Provider = freeRDPFileProvider(RdpFileTransferProvider, (type, data) => native.send(type, data),
        () => ({ toRemote: true, fromRemote: true }), () => {})
    provider = new Provider({ storageBackend: 'blob' })
    provider.on('files-available', files => { fileEvents = files })
    provider.on('error', error => console.error('Transfer:', error.message))
    await native.connect({ host, username, password, domain: process.env.TRD_TEST_DIRECT_DOMAIN || '',
        width: 1024, height: 768, pipeline: false, clipboard: { toRemote: true, fromRemote: true },
        remoteText: text => { remoteText = text }, clipboardFiles: (type, data) => provider.receive(type, data),
        open: async () => { const socket = connect(port, host); await once(socket, 'connect'); return socket },
        certificate: fp => assert.equal(fp, fingerprint.toUpperCase()),
        withoutNla: () => { throw new Error('NLA required') }, frame: () => {},
    })
    console.log('Connected:', runtime)
    await sleep(4000)
    const remote = `$p=Join-Path $env:TEMP '${prefix}';`
    let created = false
    try {
        await run(remote + `New-Item -ItemType Directory -Force -Path $p,"$p\\nested"|Out-Null;` +
            `[IO.File]::WriteAllText("$p\\nested\\hello.txt",'hello from remote');` +
            `[IO.File]::WriteAllBytes("$p\\empty.bin",[byte[]]@());` +
            `[IO.File]::WriteAllBytes("$p\\binary.bin",[byte[]](0..255)*4097);Set-Clipboard -Path $p`)
        created = true
        const files = await wait(() => fileEvents.some(f => f.name === 'hello.txt') && fileEvents, 'remote descriptors')
        assert.ok(files.some(f => f.name === 'nested' && f.isDirectory))
        for (const [index, file] of files.entries()) {
            if (file.isDirectory) continue
            const result = await provider.downloadFile(file, index).completion
            const bytes = Buffer.from(await result.arrayBuffer())
            if (file.name === 'hello.txt') assert.equal(bytes.toString(), 'hello from remote')
            if (file.name === 'empty.bin') assert.equal(bytes.length, 0)
            if (file.name === 'binary.bin') {
                assert.equal(bytes.length, 256 * 4097)
                for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], i % 256)
            }
            console.log('PASS download:', file.name, bytes.length)
        }
        await run(remote + 'Start-Process explorer.exe $p')
        await sleep(1500)
        const data = Buffer.alloc(2 * 1024 * 1024 + 31)
        for (let i = 0; i < data.length; i++) data[i] = i % 251
        const upload = provider.uploadFiles([
            { file: new Blob([]), name: 'uploaded', size: 0, isDirectory: true },
            { file: new Blob([data]), name: 'binary.bin', path: 'uploaded', size: data.length, lastModified: 0 },
            { file: new Blob([]), name: 'empty.bin', path: 'uploaded', size: 0, lastModified: 0 },
        ])
        await sleep(700); paste()
        let timeout
        try {
            await Promise.race([upload.completion, new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Upload timed out')), 20000)
            })])
        } finally { clearTimeout(timeout) }
        remoteText = ''
        await run(remote + `$h=(Get-FileHash -Algorithm SHA256 "$p\\uploaded\\binary.bin").Hash;` +
            `$n=(Get-Item "$p\\uploaded\\empty.bin").Length;Set-Clipboard -Value ('HASH:'+$h+':'+$n)`)
        await wait(() => remoteText.startsWith('HASH:'), 'uploaded hash')
        assert.equal(remoteText.trim().toLowerCase(), 'hash:' + createHash('sha256').update(data).digest('hex') + ':0')
        console.log('PASS folder upload: 2 MiB binary SHA-256 and empty file')
    } finally {
        if (created) await run(remote + "Remove-Item -LiteralPath $p -Recurse -Force;Set-Clipboard -Value ''")
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => { provider?.dispose(); native.shutdown() })
