/**
 * The on-screen display naming a desktop for a moment, like a TV's or an HDMI switcher's input overlay: large condensed
 * letters, white with a soft shadow and a faint glow behind them, so they read on light and dark pictures alike.
 * `remoteDesktop.osd` in the config; the settings page previews it.
 */
export interface OsdSettings {
    /** 'auto': where nothing else says which desktop a pane shows (a split, a desktop other than the pane's own). */
    show: 'auto' | 'always' | 'off'
    font: keyof typeof OSD_FONTS
    size: keyof typeof OSD_SIZES
    position: typeof OSD_POSITIONS[number]
    /** '' for the default (white); else a CSS color. */
    color: string
    seconds: number
}

/** Font stacks: macOS's, then Windows' (Bahnschrift) and common Linux ones, then any sans-serif. */
export const OSD_FONTS = {
    condensed: { label: 'Condensed (DIN Condensed)', family: '"DIN Condensed", "Bahnschrift Condensed", Bahnschrift, "Roboto Condensed", "Arial Narrow", sans-serif', weight: 700, stretch: 'condensed' },
    din: { label: 'Road sign (DIN Alternate)', family: '"DIN Alternate", Bahnschrift, "D-DIN", Roboto, sans-serif', weight: 700, stretch: 'normal' },
    slender: { label: 'Slender (Avenir Next Condensed)', family: '"Avenir Next Condensed", "Bahnschrift SemiLight Condensed", "Roboto Condensed", "Arial Narrow", sans-serif', weight: 500, stretch: 'condensed' },
    slenderBold: { label: 'Slender, heavier', family: '"Avenir Next Condensed", "Bahnschrift SemiBold Condensed", "Roboto Condensed", "Arial Narrow", sans-serif', weight: 600, stretch: 'condensed' },
    system: { label: 'System font', family: 'system-ui, sans-serif', weight: 600, stretch: 'normal' },
} as const

/** Letter height in px; smaller in a narrow pane (see render()). */
export const OSD_SIZES = { small: 28, medium: 44, large: 60, huge: 80 } as const

export const OSD_POSITIONS = ['top-left', 'top-center', 'top-right', 'middle', 'bottom-left', 'bottom-center', 'bottom-right'] as const

export const OSD_DEFAULTS: OsdSettings = { show: 'auto', font: 'condensed', size: 'medium', position: 'top-right', color: '', seconds: 2.5 }

/** Whether `key` is one of the table's own entries: 'constructor' or '__proto__' from the config are no font or size. */
function isOwn<T extends object> (table: T, key: unknown): key is keyof T {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key)
}

/**
 * A color from the config, or '' for the default. Only plain colors: a name, #hex, or a color function of numbers.
 * CSS.supports alone isn't enough: a value with var() passes it whatever follows (`var(--x, red)"><img …>`).
 */
export function osdColor (value: unknown): string {
    const plain = typeof value === 'string' && /^(#[0-9a-f]{3,8}|[a-z]+|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([\w\s.,%/+-]*\))$/i.test(value)
    return plain && CSS.supports('color', value) ? value : ''
}

/**
 * A number from the config, or NaN: only from a number or a string. Number() of an object calls its own conversions,
 * and a config can hold an object whose `valueOf` and `toString` aren't functions, which makes it throw.
 */
export function configNumber (value: unknown): number {
    return typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
}

/** The config value, with anything missing or unknown replaced by the default. */
export function osdSettings (value: any): OsdSettings {
    const v = value && typeof value === 'object' ? value : {}
    const seconds = configNumber(v.seconds)
    return {
        show: ['auto', 'always', 'off'].includes(v.show) ? v.show : OSD_DEFAULTS.show,
        font: isOwn(OSD_FONTS, v.font) ? v.font : OSD_DEFAULTS.font,
        size: isOwn(OSD_SIZES, v.size) ? v.size : OSD_DEFAULTS.size,
        position: OSD_POSITIONS.includes(v.position) ? v.position : OSD_DEFAULTS.position,
        color: osdColor(v.color),
        seconds: Number.isFinite(seconds) && seconds >= 0.5 && seconds <= 30 ? seconds : OSD_DEFAULTS.seconds,
    }
}

export const OSD_STYLE = `
.trd-osd { position: absolute; inset: 0; pointer-events: none; z-index: 3; opacity: 0; transition: opacity 0.5s; overflow: hidden; }
.trd-osd.trd-shown { opacity: 1; transition: opacity 0.12s; }
.trd-osd-glow { position: absolute; width: 520px; height: 300px; max-width: 100%; max-height: 100%; }
.trd-osd-box { position: absolute; display: flex; flex-direction: column; gap: 0.14em; color: #fff; text-transform: uppercase;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); white-space: nowrap; max-width: calc(100% - 40px); }
.trd-osd-name { line-height: 1; letter-spacing: 0.04em; overflow: hidden; text-overflow: ellipsis; }
.trd-osd-sub { display: flex; align-items: center; gap: 0.6em; font-size: max(11px, 0.3em); letter-spacing: 0.22em; }
.trd-osd-sub:empty { display: none; }
.trd-osd-bar { width: 1.6em; height: 3px; flex: none; background: var(--bs-primary, #3b82f6); }
`

/** Where the letters and the glow sit, per position. */
function place (position: OsdSettings['position']): { box: string, glow: string, align: string } {
    const [v, h] = position === 'middle' ? ['middle', 'center'] : position.split('-')
    const box = [
        // Below a desktop's own top bar (GNOME's is about 32 px), not over its clock.
        v === 'top' ? 'top: 56px' : v === 'bottom' ? 'bottom: 20px' : 'top: 50%',
        h === 'left' ? 'left: 24px' : h === 'right' ? 'right: 24px' : 'left: 50%',
        `transform: translate(${h === 'center' ? '-50%' : '0'}, ${v === 'middle' ? '-50%' : '0'})`,
    ].join('; ')
    const at = `${v === 'middle' ? 'center' : v} ${h === 'center' ? 'center' : h}`
    const glow = [
        v === 'top' ? 'top: 0' : v === 'bottom' ? 'bottom: 0' : 'top: 50%',
        h === 'left' ? 'left: 0' : h === 'right' ? 'right: 0' : 'left: 50%',
        `transform: translate(${h === 'center' ? '-50%' : '0'}, ${v === 'middle' ? '-50%' : '0'})`,
        `background: radial-gradient(ellipse at ${at}, rgba(0, 0, 0, 0.42), rgba(0, 0, 0, 0.18) 45%, transparent 72%)`,
    ].join('; ')
    return { box, glow, align: h === 'left' ? 'flex-start' : h === 'right' ? 'flex-end' : 'center' }
}

/**
 * Fills `el` (a .trd-osd) with `name` and an optional second line, as the settings say. The settings are checked
 * again, whoever passes them, and the overlay is built node by node with its styles set through the CSSOM: nothing
 * from the config is ever parsed as markup, which in Tabby's window (Node integration) would run as code.
 */
export function renderOsd (el: HTMLElement, name: string, sub: string, settings: OsdSettings): void {
    const checked = osdSettings(settings)
    const font = OSD_FONTS[checked.font]
    const { box, glow, align } = place(checked.position)
    // Smaller in a narrow pane: a name should fit in about two thirds of it.
    const width = el.offsetWidth || 800  // layout width: the settings preview is a scaled-down desktop
    const size = Math.max(18, Math.min(OSD_SIZES[checked.size], width / Math.max(4, name.length) * 1.1))
    const part = (className: string) => {
        const div = document.createElement('div')
        div.className = className
        return div
    }
    const glowEl = part('trd-osd-glow')
    glowEl.style.cssText = glow
    const boxEl = part('trd-osd-box')
    boxEl.style.cssText = box
    boxEl.style.setProperty('align-items', align)
    boxEl.style.setProperty('font-family', font.family)
    boxEl.style.setProperty('font-weight', String(font.weight))
    boxEl.style.setProperty('font-stretch', font.stretch)
    boxEl.style.setProperty('font-size', `${size}px`)
    if (checked.color) {
        boxEl.style.setProperty('color', checked.color)
    }
    const nameEl = part('trd-osd-name')
    nameEl.textContent = name
    const subEl = part('trd-osd-sub')
    if (sub) {
        const bar = document.createElement('span')
        bar.className = 'trd-osd-bar'
        subEl.append(bar, document.createTextNode(sub))
    }
    boxEl.append(nameEl, subEl)
    el.replaceChildren(glowEl, boxEl)
}
