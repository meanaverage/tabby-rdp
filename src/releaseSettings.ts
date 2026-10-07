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
    const status = releases.checking ? 'Checking…' : releases.checkedAt !== null ? `Last checked ${new Date(releases.checkedAt).toLocaleString()}.` : 'Not checked'
    root.innerHTML = `
        <div class="trd-release-summary">
            <div><span class="trd-sub">Running version</span><h4>tabby-rdp ${esc(releases.running)}</h4></div>
            <button class="btn btn-link btn-sm" data-release-notes="${esc(releases.running)}">Release notes</button>
        </div>
        ${releases.pending ? `<div class="trd-release-notice" role="status"><b>Restart required to use ${esc(releases.pending)}.</b> Close remote desktops and restart Tabby.</div>` : ''}
        ${releases.removed ? '<div class="trd-release-notice" role="status"><b>Plugin uninstalled.</b> Close remote desktops and restart Tabby.</div>' : ''}
        ${releases.notice ? `<p role="status">${esc(releases.notice)}</p>` : ''}
        ${releases.storageWarning ? `<p role="alert">${esc(releases.storageWarning)}</p>` : ''}
        <div class="form-line">
            <div class="header"><label class="title" for="trd-release-channel">Release channel</label><div class="description">Preview includes beta releases and release candidates.</div></div>
            <select id="trd-release-channel" class="form-control" data-channel ${disable(blocked)}><option value="stable" ${releases.state.channel === 'stable' ? 'selected' : ''}>Stable</option><option value="preview" ${releases.state.channel === 'preview' ? 'selected' : ''}>Preview</option></select>
        </div>
        <label class="trd-release-pause"><input type="checkbox" data-pause ${disable(releases.busy)} ${!releases.state.paused ? 'checked' : ''}> Check for updates automatically</label>
        <div class="trd-release-actions"><button class="btn btn-secondary btn-sm" data-check ${disable(releases.checking || releases.busy)}>Check now</button><span class="trd-sub" role="status">${esc(status)}</span></div>
        ${releases.error ? `<p class="trd-release-error" role="alert">${esc(releases.error)}${releases.catalog ? ' Showing the last successful check.' : ''}</p>` : ''}
        ${releases.state.channel === 'preview' && releases.catalog && !releases.catalog.preview ? '<p>No preview releases available.</p>' : ''}
        ${releases.recommended ? `<p>Latest: <b>${esc(releases.recommended)}</b> <button class="btn btn-link btn-sm" data-release-notes="${esc(releases.recommended)}">Release notes</button></p>` : ''}
        <h5><label for="trd-release-version">Version</label></h5>
        <div class="trd-release-actions">
            <select id="trd-release-version" class="form-control" data-version ${disable(blocked || !releases.versions.length)}>
                ${!releases.versions.length ? '<option>No versions loaded</option>' : releases.versions.map(p => {
                    const why = releases.reason(p.version)
                    return `<option value="${esc(p.version)}" ${p.version === selected ? 'selected' : ''} ${disable(!!why)}>${esc(p.version)}${why ? ` — ${esc(why)}` : ''}</option>`
                }).join('')}
            </select>
            <button class="btn btn-primary btn-sm" data-install ${disable(blocked || !!releases.error || !selected || !!reason || selected === releases.running)}>Install selected version…</button>
            <button class="btn btn-link btn-sm" data-selected-notes ${disable(!selected)}>Release notes</button>
        </div>
        <p class="trd-sub" data-version-reason ${reason ? '' : 'hidden'}>${esc(reason ?? '')}</p>
        <div class="trd-release-actions">
            ${stable && stable !== releases.running ? `<button class="btn btn-secondary btn-sm" data-stable ${disable(blocked || !!releases.error || !!releases.reason(stable))}>Return to stable ${esc(stable)}…</button>` : ''}
            <button class="btn btn-secondary btn-sm" data-restore ${disable(blocked || !!releases.error || !previous || !!releases.reason(previous) || previous === releases.running)}>Restore previous version${previous ? ` (${esc(previous)})` : ''}…</button>
        </div>
        ${!previous ? '<p class="trd-sub">No previous version saved.</p>' : releases.reason(previous) ? `<p class="trd-sub">Previous version unavailable: ${esc(releases.reason(previous))}</p>` : ''}
        <h5>Disable or uninstall</h5>
        <p class="trd-sub">Saved connections, settings, passwords and remote setup are kept.</p>
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
