// Actual Chromium canvas readback through FreeRDPView, with synthetic native IPC tiles.
// No server, credentials or FreeRDP executable required: npm test -- --hidden freerdp-rendering
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from '../lib/harness.js'

const dist = path.resolve(fileURLToPath(new URL('../../dist', import.meta.url)))

await suite('freerdp-rendering', async t => {
    t.onCleanup(() => t.ev('H.alphaView?.shutdown(); H.alphaHost?.remove()'))
    const results = await t.ev<Record<string, boolean>>(`
        const cache = require('module')._cache ?? {};
        const file = Object.keys(cache).find(k => /[\\\\/]dist[\\\\/]freerdpView\\.js$/.test(k)) ?? ${JSON.stringify(dist + '/freerdpView.js')};
        const { FreeRDPView } = require(file);
        const { decodeNativeFrame, numbers } = require(require('path').join(require('path').dirname(file), 'freerdp.js'));
        H.alphaHost = document.createElement('div');
        H.alphaHost.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;background:#111;z-index:2147483647';
        document.body.append(H.alphaHost);
        H.alphaView = new FreeRDPView({ send () {}, shutdown () {} }, H.alphaHost);
        const view = H.alphaView;
        const checks = {};
        const pixel = (x,y) => [...view.canvas.getContext('2d').getImageData(x,y,1,1).data];
        const equals = (a,b) => JSON.stringify(a) === JSON.stringify(b);
        const paint = (x,y,w,h,rgba,sw=200,sh=200) => view.paint(decodeNativeFrame(Buffer.concat([numbers(x,y,w,h,sw,sh),Buffer.from(rgba)])));
        paint(0,0,1,1,[0,0,0,255]);
        checks['opaque black stays black'] = equals(pixel(0,0),[0,0,0,255]);
        for (const alpha of [0,1,127,254,255]) {
            paint(10,20,2,1,[224,64,224,alpha,32,192,32,alpha]);
            checks['RGB survives alpha '+alpha] = equals(pixel(10,20),[224,64,224,255]) && equals(pixel(11,20),[32,192,32,255]);
        }
        checks['partial update preserves earlier pixels'] = equals(pixel(0,0),[0,0,0,255]);
        checks['partial update leaves untouched pixels alone'] = equals(pixel(12,20),[0,0,0,0]);
        paint(0,0,2,2,[224,64,224,0,32,192,32,127,96,224,96,254,0,0,0,0],320,240);
        checks['resize keeps RGB and opaque black'] = view.canvas.width===320 && view.canvas.height===240 &&
            equals(pixel(0,0),[224,64,224,255]) && equals(pixel(1,0),[32,192,32,255]) &&
            equals(pixel(0,1),[96,224,96,255]) && equals(pixel(1,1),[0,0,0,255]);
        view.shutdown();
        paint(0,0,1,1,[255,255,255,0],320,240);
        checks['shutdown prevents later paints'] = equals(pixel(0,0),[224,64,224,255]);
        return checks;
    `)
    for (const [name, passed] of Object.entries(results)) t.check(name, passed)
}, { needsHost: false })
