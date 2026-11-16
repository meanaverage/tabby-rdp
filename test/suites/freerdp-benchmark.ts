// Real FreeRDP core + production canvas inside Tabby. Dedicated target runs fixtures/performance/desktop.ps1.
// Alternates runtimes; records displayed workload frame IDs (not tile counts), bytes and input-to-pixel latency.
import fs from 'node:fs'
import path from 'node:path'
import { suite } from '../lib/harness.js'
import { parseAddress } from '../../src/desktopForm.js'

await suite('freerdp-benchmark', async t => {
    const address = parseAddress(t.env.direct.address)
    const fingerprint = process.env.TRD_TEST_CERT_SHA256
    const output = process.env.TRD_BENCH_OUTPUT
    if (!address || !t.env.direct.user || !t.env.direct.password || !fingerprint || !output) {
        throw new Error('Benchmark needs dedicated TRD_TEST_DIRECT credentials, TRD_TEST_CERT_SHA256 and TRD_BENCH_OUTPUT')
    }
    const seconds = Number(process.env.TRD_BENCH_SECONDS || 20)
    const pairs = Number(process.env.TRD_BENCH_PAIRS || 3)
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120 || !Number.isInteger(pairs) || pairs < 1 || pairs > 10) throw new Error('Invalid benchmark duration/pair count')
    t.onCleanup(() => t.ev('H.bench?.view.shutdown(); H.bench?.client.shutdown(); H.benchHost?.remove()'))
    await t.ev(`
        const file = Object.keys(require('module')._cache).find(k => /[\\\\/]dist[\\\\/]freerdp\\.js$/.test(k))
        H.benchModule = require(file)
        H.benchView = require(require('path').join(require('path').dirname(file), 'freerdpView.js')).FreeRDPView
        H.benchHost = document.createElement('div')
        H.benchHost.style.cssText = 'position:fixed;inset:0;background:black;z-index:2147483647'
        document.body.append(H.benchHost)
        const win = require('@electron/remote').getCurrentWindow(); win.show(); win.focus()
        H.benchKey = scan => { H.bench.client.send('K',H.benchModule.numbers(0,scan,0)); H.bench.client.send('K',H.benchModule.numbers(0x8000,scan,0)) }
        H.benchPixel = () => {
            const c=H.bench.view.canvas
            if(c.width<244 || c.height<16) return null
            const d=c.getContext('2d').getImageData(0,8,244,1).data
            if(d[0]!==255 || d[1]!==0 || d[2]!==255) return null
            let id=0
            for(let i=0;i<24;i++) if(d[(12+i*8)*4]>127) id|=1<<i
            return { id, pulse:d[228*4]>127 }
        }
        H.benchWindow = ms => new Promise(resolve => {
            const startUtc=new Date().toISOString(), start=performance.now(), bytes={...H.bench.client.stats}, tiles=H.bench.client.frameCount
            let last=null; const times=[], ids=[]
            const tick=()=>{
                const now=performance.now(), pixel=H.benchPixel()
                if(pixel && pixel.id!==last) { last=pixel.id; times.push(now); ids.push(pixel.id) }
                if(now-start<ms) requestAnimationFrame(tick)
                else resolve({startUtc,endUtc:new Date().toISOString(),milliseconds:now-start,displayedFrames:ids.length,ids, times:times.map(x=>x-start),
                    bytesIn:H.bench.client.stats.bytesIn-bytes.bytesIn,bytesOut:H.bench.client.stats.bytesOut-bytes.bytesOut,
                    tileUpdates:H.bench.client.frameCount-tiles})
            }; requestAnimationFrame(tick)
        })
    `)
    const results: unknown[] = []
    fs.mkdirSync(path.dirname(output), { recursive: true })
    const save = () => fs.writeFileSync(output, JSON.stringify({ schema: 1, clientPlatform: process.platform, clientArch: process.arch,
        resolution: [1280, 800], pipeline: false, seconds, pairs, results }, null, 2))
    for (const compatibility of [false, true]) for (let pair = 0; pair < pairs; pair++) {
        for (const runtime of pair % 2 ? ['wasm', 'native'] : ['native', 'wasm']) {
            const label = `${runtime}, caches/order compatibility ${compatibility}, pair ${pair + 1}`
            const connected = await t.ev<any>(`
                const client=new H.benchModule.FreeRDPProcess(${JSON.stringify(runtime)})
                const view=new H.benchView(client,H.benchHost)
                H.bench={client,view}
                const started=performance.now(); let firstPixel=null
                const size=await client.connect({host:${JSON.stringify(address.host)},username:${JSON.stringify(t.env.direct.user)},
                    password:${JSON.stringify(t.env.direct.password)},domain:'',width:1280,height:800,pipeline:false,
                    glyphCache:${compatibility},bitmapCache:${compatibility},relaxOrderChecks:${compatibility},
                    clipboard:{toRemote:false,fromRemote:false},
                    frame:frame=>{view.paint(frame); if(firstPixel===null && H.benchPixel()) firstPixel=performance.now()-started},
                    certificate:fp=>{if(fp.toUpperCase()!==${JSON.stringify(fingerprint.toUpperCase())}) throw new Error('Benchmark certificate mismatch')},
                    withoutNla:()=>{throw new Error('NLA required for live benchmark')},
                    open:()=>new Promise((resolve,reject)=>{const s=require('net').connect(${address.port},${JSON.stringify(address.host)});s.once('connect',()=>resolve(s));s.once('error',reject)})})
                const connectMs=performance.now()-started
                for(let i=0;i<150 && firstPixel===null;i++) await new Promise(r=>setTimeout(r,100))
                return {connectMs,firstPixelMs:firstPixel,size,mainPid:require('@electron/remote').process.pid}
            `)
            t.check(`${label}: workload pixels arrive`, connected.firstPixelMs !== null, connected)
            if (connected.firstPixelMs === null) throw new Error('Dedicated workload is not visible')
            // Click away from the marker so the workload owns keyboard input.
            await t.ev(`H.bench.client.send('M',H.benchModule.numbers(0x9000,400,400));H.bench.client.send('M',H.benchModule.numbers(0x1000,400,400))`)
            await t.ev('H.benchKey(0x42)'); await t.sleep(4000)
            const motion = await t.ev<any>(`return await H.benchWindow(${seconds * 1000})`)
            t.check(`${label}: motion advances`, motion.displayedFrames > seconds * 5, motion.displayedFrames)
            const latency = await t.ev<number[]>(`
                const samples=[]
                for(let i=0;i<12;i++) {
                    const before=H.benchPixel().pulse, start=performance.now(); H.benchKey(0x40)
                    while(performance.now()-start<15000 && H.benchPixel()?.pulse===before) await new Promise(requestAnimationFrame)
                    if(H.benchPixel()?.pulse===before) { samples.push(-1); break }
                    samples.push(performance.now()-start); await new Promise(r=>setTimeout(r,150))
                }
                return samples
            `)
            await t.ev('H.benchKey(0x41)'); await t.sleep(1000)
            const idle = await t.ev<any>(`return await H.benchWindow(5000)`)
            await t.ev('H.benchKey(0x42)'); await t.sleep(600)
            const image = await t.ev<string>('return H.bench.view.canvas.toDataURL()')
            fs.writeFileSync(path.join(path.dirname(output), `${runtime}-${compatibility}-${pair}.png`), Buffer.from(image.split(',')[1], 'base64'))
            const result = { runtime, compatibility, pair, startedAt: new Date().toISOString(), connected, motion, idle, latencyMs: latency }
            results.push(result); save()
            t.time(`${label}: ${(motion.displayedFrames / (motion.milliseconds / 1000)).toFixed(1)} displayed workload frames/s`, 0)
            t.check(`${label}: input changes the latency patch`, latency.length === 12 && latency.every(ms => ms >= 0), latency)
            t.check(`${label}: idle stops animation`, idle.displayedFrames <= 2, idle.displayedFrames)
            await t.ev('H.bench.view.shutdown(); H.bench.client.shutdown()')
            await t.sleep(1500)
        }
    }
}, { needsHost: false })
