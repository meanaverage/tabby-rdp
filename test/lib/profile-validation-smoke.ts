import type { TestContext } from './harness.js'

/** Exercise the host's real Save method and modal close behavior without connecting to a desktop. */
export async function profileValidationSmoke (t: TestContext): Promise<void> {
    const { ev, check, waitFor } = t
    const before = await ev<string>('return JSON.stringify(H.config.store.profiles)')
    const defaultsBefore = await ev<string>('return JSON.stringify(H.config.store.profileDefaults)')
    t.onCleanup(() => ev(`H.validationModalSub?.unsubscribe(); H.config.store.profiles = ${before};
        H.config.store.profileDefaults = ${defaultsBefore}; await H.config.save()`))
    await ev(`
        const modal = RD.injector.get(require('@ng-bootstrap/ng-bootstrap').NgbModal);
        H.validationModalSub = modal.activeInstances.subscribe(refs => { if (refs.length) H.validationModal = refs[refs.length - 1]; });
        H.config.store.profiles.push({ id: 'rdp:validation-smoke', type: 'rdp', name: 'Validation smoke',
            options: { host: 'old.example', port: 3389, gateway: 'old-gateway.example' } });
        await H.config.save(); RD.help.open('desktops');
    `)
    await waitFor(`return [...document.querySelectorAll('.trd-settings [data-list=desktops] .trd-row')].some(r => r.textContent.includes('Validation smoke'))`, 5)
    await ev(`H.inZone(() => [...document.querySelectorAll('.trd-settings [data-list=desktops] .trd-row')].find(r => r.textContent.includes('Validation smoke')).querySelector('button').click())`)
    if (!await waitFor('return !!document.querySelector(".modal rdp-profile-settings [name=address]")', 5)) {
        throw new Error('Validation smoke profile editor did not open')
    }
    await ev(`H.validationInput = (name, value) => {
        const input = document.querySelector('.modal rdp-profile-settings [name=' + name + ']');
        input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
        return input;
    }`)
    for (const [address, gateway, field] of [
        ['old.example:70000', 'new-gateway.example', 'address'],
        ['new.example:3390', 'https://gateway.example', 'gateway'],
    ]) {
        check(`invalid ${field}: host Save keeps the modal open and both stored fields unchanged`, await ev(`
            H.validationInput('address', ${JSON.stringify(address)}); H.validationInput('gateway', ${JSON.stringify(gateway)});
            // Catch the expected validation error at the caller of the real host Save method, avoiding an intentional
            // exception in Angular's global error logger. The same method is bound to the modal's Save button.
            let error;
            H.inZone(() => { try { H.validationModal.componentInstance.save(); } catch (e) { error = e.message; } });
            const root = document.querySelector('.modal rdp-profile-settings');
            const saved = H.config.store.profiles.find(p => p.id === 'rdp:validation-smoke').options;
            const draft = H.validationModal.componentInstance.profile.options;
            return error?.startsWith('Cannot save this RDP profile:') && !!root &&
                document.activeElement === root.querySelector('[name=${field}]') && !!root.querySelector('[data-for=${field}]').textContent &&
                saved.host === 'old.example' && saved.gateway === 'old-gateway.example' &&
                draft.host === 'old.example' && draft.gateway === 'old-gateway.example';
        `))
    }
    await ev(`
        H.validationInput('address', 'new.example:3390'); H.validationInput('gateway', 'new-gateway.example:444');
        H.inZone(() => document.querySelector('.modal .modal-footer .btn-primary').click());
    `)
    check('corrected fields save through the host button and close the editor', !!await waitFor(`
        const saved = H.config.store.profiles.find(p => p.id === 'rdp:validation-smoke').options;
        return !document.querySelector('.modal') && saved.host === 'new.example' && saved.port === 3390 && saved.gateway === 'new-gateway.example:444';
    `, 5))
    for (const scenario of [
        { label: 'empty type', mode: 'enabled', options: {}, globalPort: 3389, expectedPort: 3389, ownPort: false },
        { label: 'empty group', mode: 'group', options: {}, globalPort: 3389, expectedPort: 3389, ownPort: false },
        { label: 'custom type', mode: 'enabled', options: { port: 3390 }, globalPort: 3389, expectedPort: 3390, ownPort: true },
        { label: 'custom group', mode: 'group', options: { port: 3390 }, globalPort: 3389, expectedPort: 3390, ownPort: true },
        { label: 'inherited group', mode: 'group', options: {}, globalPort: 3390, expectedPort: 3390, ownPort: false },
    ]) {
        await ev(`H.inZone(() => {
            H.config.store.profileDefaults.rdp = { options: { port: ${scenario.globalPort} } };
            const modal = RD.injector.get(require('@ng-bootstrap/ng-bootstrap').NgbModal).open(require('tabby-settings').EditProfileModalComponent, { size: 'lg' });
            modal.componentInstance.partialProfile = { type: 'rdp', options: ${JSON.stringify(scenario.options)} };
            modal.componentInstance.profileProvider = RD.injector.get(require('tabby-core').ProfilesService).getProviders().find(p => p.id === 'rdp');
            modal.componentInstance.defaultsMode = ${JSON.stringify(scenario.mode)};
            H.defaultsResult = modal.result.catch(() => null);
        })`)
        if (!await waitFor('return !!document.querySelector(".modal rdp-profile-settings [name=address]")', 5)) {
            throw new Error(`${scenario.label} defaults editor did not open`)
        }
        const defaults = await ev<{ saved: boolean, address: string, host: string, port: number, ownPort: boolean, gateway: string, followsDefault: boolean }>(`
            const address = document.querySelector('.modal rdp-profile-settings [name=address]').value;
            H.validationInput('gateway', 'defaults-gateway.example:444');
            H.inZone(() => document.querySelector('.modal .modal-footer .btn-primary').click());
            const result = await H.defaultsResult;
            if (!result) return { saved: false };
            // Resolve the modal's cleaned result through the host's real ConfigProxy, with its defaults-mode rules.
            const profiles = RD.injector.get(require('tabby-core').ProfilesService);
            const rules = { skipGlobalDefaults: ${scenario.mode === 'enabled'}, skipGroupDefaults: ${scenario.mode === 'group'} };
            const effective = profiles.getConfigProxyForProfile(result, rules).options;
            const values = { saved: true, address, host: effective.host, port: effective.port,
                ownPort: Object.prototype.hasOwnProperty.call(result.options, 'port'), gateway: effective.gateway };
            H.config.store.profileDefaults.rdp.options.port = 3391;
            const followsDefault = profiles.getConfigProxyForProfile(result, rules).options.port === 3391;
            return { ...values, followsDefault };
        `)
        check(`${scenario.label} defaults: gateway Save preserves blank address and port through host cleanup`,
            defaults.saved && !defaults.address && !defaults.host && defaults.port === scenario.expectedPort &&
            defaults.ownPort === scenario.ownPort && defaults.gateway === 'defaults-gateway.example:444' &&
            defaults.followsDefault === (scenario.mode === 'group' && !scenario.ownPort) &&
            !!await waitFor('return !document.querySelector(".modal")', 5), defaults)
    }
}
