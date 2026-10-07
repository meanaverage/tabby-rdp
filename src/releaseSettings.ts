import { esc, TROUBLESHOOTING_URL } from './help'
import { ReleaseManager } from './releases'

/** Rebuilt from manager state; every package mutation stays behind the manager's confirmation and validation. */
export function renderReleaseSettings (
    root: HTMLElement, releases: ReleaseManager,
    actions: { notes: (version: string) => void, plugins: () => void, link: (url: string) => void },
): void {
    const oldSelection = root.dataset.releaseChannel === releases.state.channel ? root.querySelector<HTMLSelectElement>('[data-version]')?.value : undefined
    root.dataset.releaseChannel = releases.state.channel
    const selected = releases.versions.some(p => p.version === oldSelection) ? oldSelection! : releases.recommended ?? ''
    const blocked = releases.busy || releases.checking || !!releases.pending || releases.removed
    const disable = (condition: boolean) => condition ? 'disabled' : ''
    const reason = selected ? releases.reason(selected) : null
    const stable = releases.catalog?.stable
    const previous = releases.state.previous
    const status = releases.checking ? 'Checking npm…' : releases.checkedAt !== null ? `Last checked ${new Date(releases.checkedAt).toLocaleString()}.` : 'Published versions have not been checked yet.'
    root.innerHTML = `
        <div class="trd-release-summary">
            <div><span class="trd-sub">Installed version</span><h4>tabby-rdp ${esc(releases.running)}</h4></div>
            <button class="btn btn-link btn-sm" data-release-notes="${esc(releases.running)}">Release notes</button>
        </div>
        ${releases.pending ? `<div class="trd-release-notice" role="status"><b>${esc(releases.pending)} is installed for the next restart.</b> This window still runs ${esc(releases.running)}. Close your desktops and restart Tabby when ready.</div>` : ''}
        ${releases.removed ? '<div class="trd-release-notice" role="status"><b>The plugin package was removed.</b> This window is still running it. Close your desktops and restart Tabby when ready.</div>' : ''}
        ${releases.notice ? `<p role="status">${esc(releases.notice)}</p>` : ''}
        ${releases.storageWarning ? `<p role="alert">${esc(releases.storageWarning)}</p>` : ''}
        <div class="form-line">
            <div class="header"><label class="title" for="trd-release-channel">Release channel</label><div class="description">Stable releases are recommended for everyday use. Preview includes beta releases and release candidates, which may contain unfinished changes.</div></div>
            <select id="trd-release-channel" class="form-control" data-channel ${disable(blocked)}><option value="stable" ${releases.state.channel === 'stable' ? 'selected' : ''}>Stable</option><option value="preview" ${releases.state.channel === 'preview' ? 'selected' : ''}>Preview (beta and release candidates)</option></select>
        </div>
        <label class="trd-release-pause"><input type="checkbox" data-pause ${disable(releases.busy)} ${!releases.state.paused ? 'checked' : ''}> Check for updates automatically</label>
        <p class="trd-sub">Checks npm once a day and notifies you about new versions on your selected channel. You can check manually at any time. Channel and notification preferences apply to this Tabby profile on this computer. Installation and restart require your confirmation.</p>
        <div class="trd-release-actions"><button class="btn btn-secondary btn-sm" data-check ${disable(releases.checking || releases.busy)}>Check now</button><span class="trd-sub" role="status">${esc(status)}</span></div>
        ${releases.error ? `<p class="trd-release-error" role="alert">${esc(releases.error)}${releases.catalog ? ' The list below is from the last successful check.' : ''}</p>` : ''}
        ${releases.state.channel === 'preview' && releases.catalog && !releases.catalog.preview ? '<p>No preview releases are currently available.</p>' : ''}
        ${releases.recommended ? `<p>Available on this channel: <b>${esc(releases.recommended)}</b>.${releases.recommended === releases.running ? ' You are running this version.' : ''} <button class="btn btn-link btn-sm" data-release-notes="${esc(releases.recommended)}">Release notes</button></p>` : ''}
        <h5>Choose a version</h5>
        <label for="trd-release-version" class="trd-sub">Published versions for this channel</label>
        <div class="trd-release-actions">
            <select id="trd-release-version" class="form-control" data-version ${disable(blocked || !releases.versions.length)}>
                ${!releases.versions.length ? '<option>No published versions loaded</option>' : releases.versions.map(p => {
                    const why = releases.reason(p.version)
                    return `<option value="${esc(p.version)}" ${p.version === selected ? 'selected' : ''} ${disable(!!why)}>${esc(p.version)}${why ? ` — ${esc(why)}` : ''}</option>`
                }).join('')}
            </select>
            <button class="btn btn-primary btn-sm" data-install ${disable(blocked || !!releases.error || !selected || !!reason || selected === releases.running)}>Install selected version…</button>
            <button class="btn btn-link btn-sm" data-selected-notes ${disable(!selected)}>Release notes</button>
        </div>
        <p class="trd-sub" data-version-reason>${esc(reason ?? 'Choose a version, confirm the change, then restart Tabby when ready.')}</p>
        <div class="trd-release-actions">
            ${stable && stable !== releases.running ? `<button class="btn btn-secondary btn-sm" data-stable ${disable(blocked || !!releases.error || !!releases.reason(stable))}>Return to stable ${esc(stable)}…</button>` : ''}
            <button class="btn btn-secondary btn-sm" data-restore ${disable(blocked || !!releases.error || !previous || !!releases.reason(previous) || previous === releases.running)}>Restore previous version${previous ? ` (${esc(previous)})` : ''}…</button>
        </div>
        <p class="trd-sub">${previous ? releases.reason(previous) ? `Previous version: ${esc(releases.reason(previous))} ` : '' : 'A previous version is saved after a successful installation from this page. '}Returning to stable can be a downgrade. Only versions compatible with this Tabby and your saved data are offered. Replacing the package does not restore changed settings or deleted credentials.</p>
        <h5>Disable or uninstall</h5>
        <p class="trd-sub">Uninstall removes this plugin. Saved connections, settings, passwords and remote setup are kept.</p>
        <div class="trd-release-actions"><button class="btn btn-secondary btn-sm" data-plugins>Manage in Tabby…</button><button class="btn btn-outline-danger btn-sm" data-uninstall ${disable(blocked)}>Uninstall plugin…</button><a href="#" data-recovery>Cleanup instructions</a></div>`
    root.querySelector<HTMLSelectElement>('[data-channel]')!.addEventListener('change', e => {
        void releases.setChannel((e.target as HTMLSelectElement).value)
    })
    root.querySelector<HTMLInputElement>('[data-pause]')!.addEventListener('change', e => { void releases.setPaused(!(e.target as HTMLInputElement).checked) })
    root.querySelector('[data-check]')!.addEventListener('click', () => { void releases.refreshCatalog(true) })
    root.querySelector<HTMLSelectElement>('[data-version]')!.addEventListener('change', () => renderReleaseSettings(root, releases, actions))
    root.querySelector('[data-install]')!.addEventListener('click', () => { void releases.install(selected) })
    root.querySelector('[data-stable]')?.addEventListener('click', () => { if (stable) { void releases.install(stable, true) } })
    root.querySelector('[data-restore]')!.addEventListener('click', () => { if (previous) { void releases.install(previous) } })
    root.querySelector('[data-uninstall]')!.addEventListener('click', () => { void releases.uninstall() })
    root.querySelector('[data-plugins]')!.addEventListener('click', actions.plugins)
    root.querySelector('[data-recovery]')!.addEventListener('click', e => { e.preventDefault(); actions.link(`${TROUBLESHOOTING_URL}#recovery`) })
    root.querySelector('[data-selected-notes]')!.addEventListener('click', () => actions.notes(selected))
    root.querySelectorAll<HTMLElement>('[data-release-notes]').forEach(el => el.addEventListener('click', () => actions.notes(el.dataset.releaseNotes!)))
}
