import type { TestContext } from './harness.js'

/** Real host profile inheritance and gateway prompts, with dummy credentials and no network connection. */
export async function gatewayAccountSmoke (t: TestContext): Promise<void> {
    const { ev, check, waitFor } = t
    const before = await ev<string>('return JSON.stringify({ profiles: H.config.store.profiles, groups: H.config.store.groups })')
    t.onCleanup(() => ev(`Object.assign(H.config.store, ${before}); await H.config.save(); H.gatewayOverlay?.remove()`))
    t.onCleanup(() => ev(`const a = RD.desktop.accounts().find(a => a.name === 'Smoke gateway'); if (a) await RD.desktop.removeAccount(a.id)`))
    await ev(`
        const { id } = await RD.desktop.saveAccount({ name: 'Smoke gateway', username: 'gateway-only' }, 'dummy-gateway');
        H.gatewayAccountId = id;
        H.gatewayProfile = { id: 'rdp:gateway-smoke', type: 'rdp', name: 'Inherited gateway smoke', group: 'gateway-smoke',
            options: { host: 'desktop.example', username: 'destination-only' } };
        H.config.store.groups.push({ id: 'gateway-smoke', name: 'Gateway smoke',
            defaults: { rdp: { options: { gateway: 'gateway.example', gatewayAccount: id, via: 'ssh:gateway-smoke', kind: 'xrdp' } } } });
        H.config.store.profiles.push({ id: 'ssh:gateway-smoke', type: 'ssh', name: 'Gateway smoke jump', options: { host: 'jump.example' } }, H.gatewayProfile);
        await H.config.save(); RD.help.open('desktops');
    `)
    const row = await waitFor<string>(`return [...document.querySelectorAll('.trd-settings [data-list=desktops] .trd-row')].find(r => r.textContent.includes('Inherited gateway smoke'))?.textContent`, 5)
    check('inventory shows inherited gateway, account, SSH route and kind', !!row && ['Through the gateway gateway.example, as Smoke gateway', 'via Gateway smoke jump', 'xrdp', 'Signs in as destination-only'].every(text => row.includes(text)), row)
    check('account use enumeration includes an inherited gateway-only account', await ev(`return RD.desktop.accountUses(H.gatewayAccountId).some(u => u.profileId === H.gatewayProfile.id)`))
    check('removal confirmation names the inherited profile; Keep preserves the account', await ev(`
        const platform = RD.injector.get(require('tabby-core').PlatformService), original = platform.showMessageBox;
        let question;
        try {
            platform.showMessageBox = async options => { question = options; return { response: 1 }; };
            const removed = await RD.desktop.confirmRemoveAccount(H.gatewayAccountId);
            return !removed && question.detail.includes('Inherited gateway smoke') && RD.desktop.accounts().some(a => a.id === H.gatewayAccountId);
        } finally { platform.showMessageBox = original; }
    `))
    await ev(`
        await RD.desktop.removeAccount(H.gatewayAccountId);
        H.gatewayResolved = RD.injector.get(require('tabby-core').ProfilesService).getConfigProxyForProfile(H.gatewayProfile);
        H.gatewayOverlay = document.createElement('div'); document.body.appendChild(H.gatewayOverlay);
        H.gatewaySession = { overlay: H.gatewayOverlay, log: [], visible: false, status () {}, disposed: new Promise(() => {}) };
        H.startGatewayPrompt = () => RD.desktop.gatewayAccountFor({ name: 'Gateway smoke', gatewayAccount: H.gatewayResolved.options.gatewayAccount },
            H.gatewaySession, { host: 'gateway.example', port: 443 });
        H.gatewayPrompt = H.startGatewayPrompt();
    `)
    check('removed group account becomes a separate gateway prompt', await ev(`return H.gatewayResolved.options.gatewayAccount === '@ask' && H.config.store.groups.find(g => g.id === 'gateway-smoke').defaults.rdp.options.gatewayAccount === '@ask'`))
    check('gateway prompt does not prefill the destination username or offer remembering', await ev(`
        const f = H.gatewayOverlay.querySelector('form');
        return !!f && f.querySelector('[name=username]').value === '' && f.querySelector('.trd-signin-remember').style.display === 'none';
    `))
    check('cancelling the gateway prompt returns no sign-in', await ev(`H.gatewayOverlay.querySelector('[name=cancel]').click(); return await H.gatewayPrompt === null`))
    check('entered gateway credentials stay separate and are not saved against a removed account', await ev(`
        H.gatewayPrompt = H.startGatewayPrompt();
        const f = H.gatewayOverlay.querySelector('form');
        f.querySelector('[name=username]').value = 'entered-gateway-only'; f.querySelector('[name=password]').value = 'dummy-entered'; f.requestSubmit();
        const result = await H.gatewayPrompt;
        return result.credentials.username === 'entered-gateway-only' && result.credentials.password === 'dummy-entered' && !result.remember && !result.saveKey;
    `))
    await ev('H.gatewayOverlay.remove()')
}
