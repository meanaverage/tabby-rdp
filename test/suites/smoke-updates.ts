// Persistent package-change UI, including a real 0.5.1 install in the runner's disposable profile.
import fs from 'node:fs'
import path from 'node:path'
import { suite } from '../lib/harness.js'
import { rendererErrors, smokeHost } from '../lib/smoke.js'

await suite('smoke-updates', async t => {
    const { ev, check, waitFor } = t
    await smokeHost(t)
    const errors = await rendererErrors(t)
    const capture = async (name: string) => {
        if (!process.env.TRD_TEST_DUMP) { return }
        const result = await t.c.send('Page.captureScreenshot', { format: 'png' })
        fs.mkdirSync(process.env.TRD_TEST_DUMP, { recursive: true })
        fs.writeFileSync(path.join(process.env.TRD_TEST_DUMP, `${name}.png`), Buffer.from(result.data, 'base64'), { mode: 0o600 })
    }
    await ev(`
        if (!process.env.TABBY_CONFIG_DIRECTORY?.includes('tabby-rdp-test-')) throw new Error('A fresh disposable profile is required');
        await RD.updates.ready;
        H.initialVersion = RD.updates.running;
        H.originalReleaseEnv = { ...RD.updates.env };
        H.packageModal = () => document.querySelector('dialog.trd-package-dialog');
        RD.updates.env.fetchCatalog = async () => ({ stable: '0.5.1', preview: null,
            versions: [{ version: '0.5.1', deprecated: false, policy: { minimumTabbyVersion: '1.0.236', rollbackFloor: '0.5.1' } }] });
        H.installCalls = 0;
        RD.updates.env.install = async () => { H.installCalls++; throw new Error('Unexpected installation'); };
        await RD.updates.refreshCatalog(true);
        RD.help.open('updates');
    `)
    check('Updates opens in the fresh profile', !!await waitFor('return !!document.querySelector(".trd-settings [data-install]")', 5))
    await ev('document.querySelector(".trd-settings [data-install]").click()')
    check('confirmation is a modal with Cancel focused', !!await waitFor(`
        const d = H.packageModal(); return d?.open && d.matches(':modal') && !d.querySelector('[data-confirm]').hidden &&
            document.activeElement === d.querySelector('[data-cancel]');
    `, 5))
    await ev('H.packageModal().querySelector("[data-cancel]").click()')
    check('Cancel closes the dialog without installing', !!await waitFor('return !H.packageModal() && !RD.updates.busy && H.installCalls === 0', 3))
    await ev('document.querySelector(".trd-settings [data-install]").click()')
    await waitFor('return H.packageModal() && !H.packageModal().querySelector("[data-confirm]").hidden', 3)
    await t.key('Escape', 'Escape', 27)
    check('Escape cancels confirmation without installing', !!await waitFor('return !H.packageModal() && !RD.updates.busy && H.installCalls === 0', 3))

    await ev(`RD.updates.env.install = () => { H.installCalls++; return new Promise((_, reject) => { H.failInstall = reject }); };
        document.querySelector('.trd-settings [data-install]').click();`)
    await waitFor('return H.packageModal() && !H.packageModal().querySelector("[data-confirm]").hidden', 3)
    await ev('H.sameModal = H.packageModal(); H.sameModal.querySelector("[data-confirm]").click()')
    check('the confirmation stays open as installation progress', !!await waitFor(`
        const d = H.packageModal(); return d === H.sameModal && d.open &&
            d.querySelector('[data-result]').dataset.phase === 'installing' &&
            !d.querySelector('progress').hidden && !d.querySelector('progress').hasAttribute('value') &&
            d.querySelector('[data-close]').hidden && d.querySelector('[data-cancel]').hidden;
    `, 3))
    await t.sleep(1200)
    check('elapsed time advances while the installer is working', await ev('return /Elapsed 0:0[1-9]/.test(H.packageModal().querySelector("[data-elapsed]").textContent)'))
    await t.key('Escape', 'Escape', 27)
    check('Escape cannot dismiss an active installation', await ev('return H.packageModal() === H.sameModal && H.sameModal.open'))
    await ev(`const tab = RD.app.tabs.find(x => x instanceof require('tabby-settings').SettingsTabComponent);
        await H.inZone(() => RD.app.closeTab(tab, false));`)
    check('the progress dialog survives closing Settings', await ev('return !document.querySelector(".trd-settings") && H.sameModal.open'))
    await capture('install-progress')
    await ev('H.failInstall(new Error("Test installation failure"))')
    check('failure remains in the same dialog with its cause', !!await waitFor(`
        const d = H.packageModal(); return d === H.sameModal && d.open &&
            d.querySelector('[data-result]').dataset.phase === 'error' &&
            d.textContent.includes('Test installation failure') && !d.querySelector('[data-close]').hidden &&
            d.querySelector('progress').hidden && RD.updates.pending === null;
    `, 3))
    await capture('install-failure')
    await ev('H.packageModal().querySelector("[data-close]").click()')
    check('Close dismisses the completed failure dialog', await ev('return !H.packageModal()'))

    // Use the host's real installer, in this disposable profile only; no user profile is changed.
    await ev(`RD.updates.env.install = H.originalReleaseEnv.install;
        H.realInstallation = RD.updates.install('0.5.1');`)
    await waitFor('return H.packageModal() && !H.packageModal().querySelector("[data-confirm]").hidden', 3)
    await ev('H.sameModal = H.packageModal(); H.sameModal.querySelector("[data-confirm]").click()')
    check('a real downgrade produces a verified success in the same dialog', !!await waitFor(`
        const d = H.packageModal(); return d === H.sameModal && d.open &&
            d.querySelector('[data-result]').dataset.phase === 'success' &&
            d.textContent.includes('tabby-rdp 0.5.1 is installed.') && d.textContent.includes('restart Tabby') &&
            RD.updates.env.diskVersion() === '0.5.1' && RD.updates.pending === '0.5.1' &&
            !d.querySelector('[data-close]').hidden;
    `, 90))
    await capture('install-success')
    check('running and installed versions stay distinct until restart', await ev('return RD.updates.running === H.initialVersion && RD.updates.running !== "0.5.1" && RD.updates.env.diskVersion() === "0.5.1"'))
    check('the credential fixture survives the real installer', await ev(`return require('fs').existsSync(require('path').join(process.env.TABBY_CONFIG_DIRECTORY,
        'plugins/node_modules/tabby-aaa-smoke-credentials/index.js'))`))
    await ev('H.packageModal().querySelector("[data-close]").click()')
    errors()
}, { needsHost: false })
