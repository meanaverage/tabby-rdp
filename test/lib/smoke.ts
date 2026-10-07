import type { TestContext } from './harness.js'
import type { HostSnapshot } from '../../src/hostCompat.js'

/** Report the host's declared dependency, rather than guessing xterm's version from private field names. */
export async function smokeHost (t: TestContext): Promise<void> {
    if (!await t.ev('return globalThis.__trdSmokeCredentials === true')) {
        throw new Error('Smoke tests require their isolated profile credential guard. Use npm run test:smoke without --port.')
    }
    const info = await t.ev<HostSnapshot>('return RD.compat.snapshot()')
    console.log('HOST  ' + JSON.stringify(info))
    const expected = process.env.TRD_SMOKE_EXPECT_XTERM
    if (expected && info.xtermMajor !== Number(expected)) {
        throw new Error(`Expected xterm ${expected}; this host declares ${JSON.stringify(info.xtermDeclaration)}`)
    }
}

/** Include caught resize failures: the host logs these instead of letting them become uncaught exceptions. */
export async function rendererErrors (t: TestContext): Promise<() => void> {
    const errors: string[] = []
    const off = t.c.on('Runtime.exceptionThrown', event => {
        errors.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? 'Unknown renderer exception')
    })
    const offConsole = t.c.on('Runtime.consoleAPICalled', event => {
        const message = event.args?.map((arg: { value?: unknown, description?: string }) => arg.value ?? arg.description ?? '').join(' ') ?? ''
        if (event.type === 'error' || event.type === 'warning' && /Could not resize xterm/.test(message)) {
            errors.push(message)
        }
    })
    await t.c.send('Runtime.enable')
    t.onCleanup(off)
    t.onCleanup(offConsole)
    return () => t.check('no renderer errors or caught xterm resize failures', errors.length === 0, errors)
}
