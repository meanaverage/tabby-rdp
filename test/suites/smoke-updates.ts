// Persistent package-change UI and the saved-data floor, with simulated compatible package changes.
import fs from 'node:fs'
import path from 'node:path'
import { suite } from '../lib/harness.js'
import { rendererErrors, smokeHost } from '../lib/smoke.js'

await suite('smoke-updates', async t => {
    const { ev, check, waitFor } = t
    await smokeHost(t)
    const errors = await rendererErrors(t)
    t.onCleanup(() => ev('if (H.originalReleaseEnv) Object.assign(RD.updates.env, H.originalReleaseEnv)'))
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
        RD.updates.env.fetchCatalog = async () => ({ stable: '0.5.2', preview: null,
            versions: ['0.5.1', '0.5.2', '0.6.0'].map(version => ({ version, deprecated: false,
                policy: { minimumTabbyVersion: '1.0.236', rollbackFloor: version === '0.6.0' ? '0.6.0' : '0.5.1' } })) });
        H.installCalls = 0;
        RD.updates.env.install = async () => { H.installCalls++; throw new Error('Unexpected installation'); };
        await RD.updates.refreshCatalog(true);
        RD.help.open('updates');
    `)
    check('Updates opens in the fresh profile', !!await waitFor('return !!document.querySelector(".trd-settings [data-install]")', 5))
    check('startup persists the gateway-prompt floor even with automatic checks paused', await ev(`
        const saved = JSON.parse(localStorage.getItem('tabby-rdp.releases.v1'));
        return saved.paused && saved.rollbackFloor === '0.5.3-rc.1';
    `))
    check('unsafe older versions and Return to stable are disabled', await ev(`
        const root = document.querySelector('.trd-settings');
        return ['0.5.1', '0.5.2'].every(version => [...root.querySelector('[data-version]').options].find(o => o.value === version)?.disabled) &&
            root.querySelector('[data-install]').disabled && root.querySelector('[data-stable]').disabled &&
            root.querySelector('[data-version-reason]').textContent.includes('0.5.3-rc.1');
    `))
    for (const version of ['0.5.1', '0.5.2']) {
        check(`${version} is refused before confirmation or installation`, await ev(`
            await RD.updates.install(${JSON.stringify(version)}, ${version === '0.5.2'});
            const d = H.packageModal();
            return H.installCalls === 0 && RD.updates.pending === null && RD.updates.error.includes('requires version 0.5.3-rc.1') &&
                d?.querySelector('[data-confirm]').hidden && d.querySelector('[data-result]').dataset.phase === 'error';
        `))
        await ev('H.packageModal().querySelector("[data-close]").click()')
    }
    // A compatible synthetic release keeps dialog checks deterministic without a published compatible RC.
    await ev(`RD.updates.error = ''; RD.updates.catalog.stable = '0.6.0';
        const select = document.querySelector('.trd-settings [data-version]');
        select.value = '0.6.0'; select.dispatchEvent(new Event('change', { bubbles: true }));`)
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

    // Simulate the disk result too: the installed plugin and credential guard remain the actual packed version.
    await ev(`H.simulatedDisk = H.initialVersion;
        RD.updates.env.diskVersion = () => H.simulatedDisk;
        RD.updates.env.install = async (name, version) => {
            if (name !== 'tabby-rdp' || version !== '0.6.0') throw new Error('Unexpected package change');
            H.installCalls++; H.simulatedDisk = version;
        };
        H.simulatedInstallation = RD.updates.install('0.6.0');`)
    await waitFor('return H.packageModal() && !H.packageModal().querySelector("[data-confirm]").hidden', 3)
    await ev('H.sameModal = H.packageModal(); H.sameModal.querySelector("[data-confirm]").click()')
    check('a compatible simulated installation produces a verified success in the same dialog', !!await waitFor(`
        const d = H.packageModal(); return d === H.sameModal && d.open &&
            d.querySelector('[data-result]').dataset.phase === 'success' &&
            d.textContent.includes('tabby-rdp 0.6.0 is installed.') && d.textContent.includes('restart Tabby') &&
            RD.updates.env.diskVersion() === '0.6.0' && RD.updates.pending === '0.6.0' &&
            !d.querySelector('[data-close]').hidden;
    `, 5))
    await capture('install-success')
    check('running and simulated installed versions stay distinct until restart', await ev('return RD.updates.running === H.initialVersion && RD.updates.env.diskVersion() === "0.6.0"'))
    check('the target release floor is persisted before restart', await ev(`
        return RD.updates.running === H.initialVersion && JSON.parse(localStorage.getItem('tabby-rdp.releases.v1')).rollbackFloor === '0.6.0';
    `))
    check('the actual installed package stays unchanged', await ev('return H.originalReleaseEnv.diskVersion() === H.initialVersion'))
    await ev('H.packageModal().querySelector("[data-close]").click()')
    errors()
}, { needsHost: false })
