// TLS-only cached bitmap peer on a disposable server, not a Senhasegura appliance or MFA test.
import fs from 'node:fs'
import path from 'node:path'
import { suite } from '../lib/harness.js'

await suite('freerdp-pam', async t => {
    const controller = process.env.TRD_PAM_CONTROLLER
    const fingerprint = process.env.TRD_PAM_FINGERPRINT
    if (!controller || !fingerprint) throw new Error('Set TRD_PAM_CONTROLLER and independently pinned TRD_PAM_FINGERPRINT')
    const request = async (route: string, value?: unknown) => {
        const response = await fetch(controller + route, { method: value === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(10000) })
        if (!response.ok) throw new Error('PAM fixture controller failed: ' + response.status)
        return response.json() as Promise<any>
    }
    t.onCleanup(async () => { await t.ev('H.pamClient?.shutdown(); H.pamView?.shutdown(); H.pamHost?.remove()'); await request('/stop', {}) })
    await t.ev(`
        const file=Object.keys(require('module')._cache).find(k=>/[\\\\/]dist[\\\\/]freerdp\\.js$/.test(k))
        H.pamModule=require(file)
        H.PamView=require(require('path').join(require('path').dirname(file),'freerdpView.js')).FreeRDPView
        H.pamHost=document.createElement('div');H.pamHost.style.cssText='position:fixed;inset:0;background:black;z-index:2147483647';document.body.append(H.pamHost)
    `)
    const results: any[] = []
    for (const glyphCache of [false, true]) for (const bitmapCache of [false, true]) for (const relaxed of [false, true]) {
        // All alpha variants with bitmap caching; a representative unsupported-cache negative case without it.
        for (const mode of bitmapCache ? ['opaque', 'transparent', 'partial', 'no-alpha', 'black'] : ['transparent']) {
            for (const runtime of ['native', 'wasm']) {
                const peer = await request('/case', { mode })
                if (peer.fingerprint !== fingerprint) throw new Error('Fixture fingerprint changed')
                const result = await t.ev<any>(`
                    const client=H.pamClient=new H.pamModule.FreeRDPProcess(${JSON.stringify(runtime)})
                    const view=H.pamView=new H.PamView(client,H.pamHost)
                    let nla=0, cert=0, ended=false, error=null
                    client.run().then(()=>{ended=true},e=>{ended=true;error=e.message})
                    try {
                        await client.connect({host:${JSON.stringify(peer.host)},username:'pam-user[CORP\\\\vault-account@target-vm]',
                            password:'synthetic-only',domain:'',width:800,height:600,pipeline:false,autologon:true,
                            glyphCache:${glyphCache},bitmapCache:${bitmapCache},relaxOrderChecks:${relaxed},authorities:[],
                            frame:f=>view.paint(f),withoutNla:()=>{nla++},certificate:fp=>{cert++;if(fp!==${JSON.stringify(fingerprint)}) throw new Error('Untrusted test certificate')},
                            open:()=>new Promise((resolve,reject)=>{const s=require('net').connect(${peer.port},${JSON.stringify(peer.host)});s.once('connect',()=>resolve(s));s.once('error',reject)})})
                        await new Promise(r=>setTimeout(r,2200))
                    } catch(e) { error=e.message }
                    const pixels=[16,48,80,112].map(x=>[...view.canvas.getContext('2d').getImageData(x,16,1,1).data])
                    const result={nla,cert,ended,error,pixels,tiles:client.frameCount}
                    view.shutdown();client.shutdown();return result
                `)
                const events = await request('/events')
                const label = `${runtime} ${mode}, glyph=${glyphCache} bitmap=${bitmapCache} relaxed=${relaxed}`
                const identity = events.events.some((e: any) => e.event === 'identity' && e.bracketedUsernamePreserved)
                t.check(label + ': TLS-only consent and intact PAM username', result.nla > 0 && result.cert > 0 && identity, { ...result, identity })
                if (bitmapCache) {
                    const expected = mode === 'black' ? Array(4).fill([0, 0, 0, 255]) : [[224, 64, 224, 255], [32, 192, 32, 255], [96, 224, 96, 255], [192, 32, 192, 255]]
                    t.check(label + ': cached colors survive and connection stays open', !result.ended && JSON.stringify(result.pixels) === JSON.stringify(expected), result)
                } else if (!relaxed) {
                    t.check(label + ': strict mode rejects unannounced bitmap caching', result.ended, result)
                }
                results.push({ runtime, mode, glyphCache, bitmapCache, relaxed, result, identity })
                if (process.env.TRD_PAM_OUTPUT) {
                    fs.mkdirSync(path.dirname(process.env.TRD_PAM_OUTPUT), { recursive: true })
                    fs.writeFileSync(process.env.TRD_PAM_OUTPUT, JSON.stringify(results, null, 2))
                }
            }
        }
    }
    for (let i = 0; i < results.length; i += 2) {
        const [native, wasm] = results.slice(i, i + 2)
        t.check(`native/WASM parity: ${native.mode}, glyph=${native.glyphCache} bitmap=${native.bitmapCache} relaxed=${native.relaxed}`,
            native.result.ended === wasm.result.ended && JSON.stringify(native.result.pixels) === JSON.stringify(wasm.result.pixels))
    }
}, { needsHost: false })
