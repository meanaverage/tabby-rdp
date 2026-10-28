import { test, expect, chromium } from '@playwright/test'
import { clientIdentity } from './identity.js'
import fs from 'node:fs'
import type { HostSnapshot } from '../../src/hostCompat.js'

const hostedSmoke = process.env.TRD_QA_TEST === 'visual-smoke'
test(hostedSmoke ? 'Native Tabby settings smoke (no baseline qualification)' : 'Remote Desktop settings in real Tabby', async ({}, info) => {
    info.annotations.push({ type: 'infrastructure', description: 'Connecting to the isolated Tabby browser' })
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.TRD_CDP_PORT}`)
    const context = browser.contexts()[0]
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    const page = context.pages().find(p => !p.url().startsWith('devtools:'))!
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
        // Use the same real plugin handle as the existing CDP suites; no duplicate or mocked UI.
        await page.waitForFunction(() => !!(window as any).__remoteDesktop)
        expect(await page.evaluate(() => (globalThis as any).__trdSmokeCredentials)).toBe(true)
        const client = await clientIdentity(script => page.evaluate(`(async () => {${script}})()`))
        info.annotations.splice(info.annotations.findIndex(a => a.type === 'infrastructure'), 1)
        const host = await page.evaluate<HostSnapshot>(() => (window as any).__remoteDesktop.compat.snapshot())
        await info.attach('host', { body: JSON.stringify({ ...host, ...client, viewport: '1100x800', scale: 1 }, null, 2), contentType: 'application/json' })
        const cdp = await context.newCDPSession(page)
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false })
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        // Compare to Tabby's own control in the same host/theme, rather than asserting a hand-copied CSS design.
        await page.evaluate(() => (window as any).__remoteDesktop.help.openSettings('window'))
        const standardToggle = page.locator('window-settings-tab toggle input[type=checkbox]').first()
        await expect(standardToggle).toBeVisible()
        const reference = await standardToggle.evaluate(el => {
            const style = getComputedStyle(el)
            return { checked: (el as HTMLInputElement).checked, width: style.width, height: style.height,
                borderRadius: style.borderRadius, backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage, cursor: style.cursor, fontSize: style.fontSize }
        })
        await info.attach('tabby-standard-toggle', { body: await standardToggle.locator('..').screenshot(), contentType: 'image/png' })
        // Open the ordinary settings page. Help-topic navigation schedules smooth scrolling.
        await page.evaluate(() => (window as any).__remoteDesktop.help.openSettings('remote-desktop'))
        const settings = page.locator('.trd-settings')
        await expect(settings).toBeVisible()
        await settings.locator('[data-tab=settings]').click()
        const soundToggle = settings.locator('[data-setting=sound]')
        await expect(settings.locator('trd-settings-toggle toggle input[type=checkbox]')).toHaveCount(process.platform === 'darwin' ? 9 : 8)
        const orderChecks = settings.locator('[data-setting=relaxOrderChecks]')
        await expect(orderChecks).toHaveAccessibleName('Relax drawing order checks (FreeRDP)')
        await expect(orderChecks).not.toBeChecked()
        await orderChecks.click()
        await expect.poll(() => page.evaluate(() => (window as any).__remoteDesktop.desktop.settings().relaxOrderChecks)).toBe(true)
        await orderChecks.click()
        await expect.poll(() => page.evaluate(() => (window as any).__remoteDesktop.desktop.settings().relaxOrderChecks)).toBe(false)
        await expect(soundToggle).toHaveAccessibleName('Sound')
        const originalSound = await soundToggle.isChecked()
        if (originalSound !== reference.checked) await soundToggle.click()
        await expect.poll(() => page.evaluate(() => (window as any).__remoteDesktop.desktop.settings().sound)).toBe(reference.checked)
        await soundToggle.evaluate(el => (el as HTMLInputElement).blur())
        await expect.poll(() => soundToggle.evaluate(el => {
            const style = getComputedStyle(el)
            return { checked: (el as HTMLInputElement).checked, width: style.width, height: style.height,
                borderRadius: style.borderRadius, backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage, cursor: style.cursor, fontSize: style.fontSize }
        })).toEqual(reference)
        // Space must change the real setting once, and external configuration changes must update the component.
        await soundToggle.focus()
        await soundToggle.press('Space')
        await expect.poll(() => page.evaluate(() => (window as any).__remoteDesktop.desktop.settings().sound)).toBe(!reference.checked)
        await page.evaluate(sound => (window as any).__remoteDesktop.desktop.updateSettings({ sound }), originalSound)
        await expect(soundToggle).toBeChecked({ checked: originalSound })
        await soundToggle.evaluate(el => (el as HTMLInputElement).blur())
        const clientChoice = settings.locator('[data-setting=client]')
        await expect(clientChoice).toBeVisible()
        await expect(clientChoice.locator('option')).toHaveText(['IronRDP', 'FreeRDP (experimental)'])
        const originalClient = await clientChoice.inputValue()
        await clientChoice.selectOption('freerdp')
        await expect.poll(() => page.evaluate(() => (window as any).__remoteDesktop.desktop.settings().client)).toBe('freerdp')
        await clientChoice.selectOption(originalClient)
        await expect(settings.locator('[data-setting=resize]')).toBeVisible()
        const headerChoice = settings.locator('[data-setting=headerAutoHide]')
        await expect(headerChoice.locator('option')).toHaveText(['Automatic', 'Never', 'Always'])
        expect(await settings.locator('[data-setting=resize]').evaluate(el => !!el.closest('.form-line')?.nextElementSibling?.querySelector('[data-setting=headerAutoHide]'))).toBe(true)
        await headerChoice.selectOption('automatic')
        await expect(settings.locator('[data-header-size]')).toBeVisible()
        await settings.locator('[data-setting=headerMinWidth]').fill('1100')
        await settings.locator('[data-setting=headerMinHeight]').fill('800')
        await settings.locator('[data-setting=headerMinHeight]').blur()
        await expect.poll(() => page.evaluate(() => {
            const settings = (window as any).__remoteDesktop.desktop.settings()
            return [settings.headerAutoHide, settings.headerMinWidth, settings.headerMinHeight]
        })).toEqual(['automatic', 1100, 800])
        await expect(page.locator('app-root')).not.toHaveClass(/trd-auto-hide-header/)
        await page.evaluate(() => (window as any).__remoteDesktop.desktop.updateSettings({ headerAutoHide: 'never', headerMinWidth: 0, headerMinHeight: 0 }))
        await expect(headerChoice).toHaveValue('never')
        await expect(settings.locator('[data-header-size]')).toBeHidden()
        await clientChoice.focus()
        await expect(settings.locator('h3')).toBeInViewport({ ratio: 1 })
        await page.evaluate(() => document.fonts.ready)
        // Persistent clients retain settings scroll after other tests use the page.
        // Establish the top-of-page precondition without changing styles or the reviewed baseline.
        const content = page.locator('settings-tab .tab-content')
        await content.evaluate(el => el.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
        await expect.poll(() => content.evaluate(el => el.scrollTop)).toBe(0)
        // Baselines are specific to OS/architecture and the actual host runtime; never cross-compare hosts.
        const key = `${client.platform}-${client.arch}-tabby-${host.version}-electron-${host.electron}`.replace(/[^a-zA-Z0-9.-]/g, '_')
        const name = `${key}/settings-viewport.png`
        // Capture the visible viewport: Electron cannot paint a tall offscreen element by scrolling a screenshot.
        await info.attach('actual', { body: await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' }), contentType: 'image/png' })
        if (!hostedSmoke && fs.existsSync(info.snapshotPath(name))) await info.attach('expected', { path: info.snapshotPath(name), contentType: 'image/png' })
        if (hostedSmoke) {
            info.annotations.push({ type: 'coverage', description: 'Real native settings visibility and renderer checks with screenshot/trace. No reviewed hosted-runner baseline; no RDP coverage.' })
            expect(host.version).toBe('1.0.236')
            expect(client.platform).toBe(process.platform)
            expect(client.arch).toBe(process.arch)
        } else await expect(page).toHaveScreenshot(name)
        expect(errors, 'renderer exceptions').toEqual([])
    } finally {
        if (!page.isClosed()) await info.attach('window', { body: await page.screenshot({ scale: 'css' }), contentType: 'image/png' }).catch(() => {})
        const trace = info.outputPath('trace.zip')
        await context.tracing.stop({ path: trace })
        await info.attach('trace', { path: trace, contentType: 'application/zip' })
        await browser.close() // disconnect CDP; the existing runner owns Tabby's lifecycle
    }
})

test('Windowed header auto-hide reveals without resizing content or changing native menu visibility', async ({}, info) => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.TRD_CDP_PORT}`)
    const page = browser.contexts()[0].pages().find(p => !p.url().startsWith('devtools:'))!
    let original: string | undefined, wasVisible = false
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
        await page.waitForFunction(() => !!(window as any).__remoteDesktop)
        const state = await page.evaluate(() => {
            const win = (globalThis as any).require('@electron/remote').getCurrentWindow()
            const visible = win.isVisible()
            win.show(); win.focus()
            return { mode: (window as any).__remoteDesktop.desktop.settings().headerAutoHide, visible,
                menuVisible: process.platform === 'darwin' ? null : win.isMenuBarVisible(),
                autoHideMenu: process.platform === 'darwin' ? null : win.isMenuBarAutoHide() }
        })
        original = state.mode; wasVisible = state.visible
        const cdp = await browser.contexts()[0].newCDPSession(page)
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false })
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        if (process.platform === 'darwin') await expect.poll(() => page.evaluate(() => {
            const menu = (globalThis as any).require('@electron/remote').Menu.getApplicationMenu()
            return menu?.getMenuItemById('tabby-rdp-hide-header-always')?.label
        })).toBe('Always')
        const body = page.locator('app-root .content-tab-active').first()
        const before = (await body.boundingBox())!.height
        await page.evaluate(() => {
            if (process.platform === 'darwin') (globalThis as any).require('@electron/remote').Menu.getApplicationMenu().getMenuItemById('tabby-rdp-hide-header-always').click()
            else (window as any).__remoteDesktop.desktop.updateSettings({ headerAutoHide: 'always' })
        })
        const root = page.locator('app-root'), bar = page.locator('app-root .tab-bar')
        await expect(root).toHaveClass(/trd-auto-hide-header/)
        await expect.poll(async () => (await body.boundingBox())!.height).toBeGreaterThan(before + 10)
        await expect(bar).toHaveCSS('visibility', 'hidden')
        await expect(bar).toHaveCSS('opacity', '0')
        expect(await bar.evaluate(el => (el as HTMLElement).inert)).toBe(true)
        const hiddenSize = (await body.boundingBox())!
        await info.attach('header-hidden', { body: await page.screenshot({ scale: 'css' }), contentType: 'image/png' })
        await page.mouse.move(500, 1)
        await expect(bar).toHaveCSS('visibility', 'visible')
        const revealedSize = (await body.boundingBox())!
        expect([revealedSize.width, revealedSize.height]).toEqual([hiddenSize.width, hiddenSize.height])
        await page.mouse.move(500, 700)
        await expect(bar).toHaveCSS('visibility', 'hidden')
        await page.evaluate(() => {
            if (process.platform === 'darwin') (globalThis as any).require('@electron/remote').Menu.getApplicationMenu().getMenuItemById('tabby-rdp-hide-header-never').click()
            else (window as any).__remoteDesktop.desktop.updateSettings({ headerAutoHide: 'never' })
        })
        await expect(root).not.toHaveClass(/trd-auto-hide-header/)
        await expect(bar).toHaveCSS('visibility', 'visible')
        if (process.platform !== 'darwin') expect(await page.evaluate(() => {
            const win = (globalThis as any).require('@electron/remote').getCurrentWindow()
            return [win.isMenuBarVisible(), win.isMenuBarAutoHide()]
        })).toEqual([state.menuVisible, state.autoHideMenu])
        expect(errors).toEqual([])
    } finally {
        if (original) await page.evaluate(mode => (window as any).__remoteDesktop.desktop.updateSettings({ headerAutoHide: mode }), original)
        if (!wasVisible) await page.evaluate(() => (globalThis as any).require('@electron/remote').getCurrentWindow().hide()).catch(() => {})
        await browser.close()
    }
})
