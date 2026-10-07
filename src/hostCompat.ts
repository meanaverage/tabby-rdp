/** Host identity is diagnostic information; behavior follows capabilities, including on forks and nightlies. */
export interface HostInfo {
    readonly name: string | null
    readonly version: string | null
    readonly platform: string | null
    readonly electron: string | null
    readonly node: string | null
    /** The bundled terminal package's declaration, not a verified xterm runtime version. */
    readonly xtermDeclaration: string | null
    readonly xtermMajor: number | null
}

type ModalStyle = Pick<CSSStyleDeclaration, 'content' | 'display' | 'height' | 'getPropertyValue'>
type StyleReader = (element: Element, pseudo: string) => ModalStyle

/** Reads are independent: an unavailable optional module must not prevent the plugin from loading. */
export interface HostSources {
    name?: () => unknown
    version?: () => unknown
    platform?: unknown
    electron?: unknown
    node?: unknown
    terminalPackage?: () => unknown
    modalStyle?: StyleReader
}

export interface HostSnapshot extends HostInfo {
    readonly capabilities: {
        /** Last observed modal. Null means no modal has been examined yet. */
        readonly nativeModalDragRegion: boolean | null
        /** The supplied pane's input. Null means no pane was supplied. */
        readonly terminalInput: boolean | null
    }
}

function text (value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 256) || null : null
}

function read (source?: () => unknown): unknown {
    try { return source?.() } catch { return undefined }
}

/** Ranges spanning multiple majors, URLs and workspace aliases cannot establish a single major. */
function declaredMajor (declaration: string | null): number | null {
    const match = declaration?.match(/^[~^]?(\d+)(?:\.(?:\d+|x|\*)(?:\.(?:\d+|x|\*))?)?(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i)
    const major = match ? Number(match[1]) : NaN
    return Number.isSafeInteger(major) ? major : null
}

/** Shared terminal DOM adapter; keep desktop layers and forms in agreement about the input they cover. */
export function terminalInputs (container: ParentNode): HTMLTextAreaElement[] {
    return Array.from(container.querySelectorAll<HTMLTextAreaElement>('textarea.xterm-helper-textarea'))
}

/** An Angular factory provides one instance per plugin window; this module itself needs no Angular runtime. */
export class HostCompatibility {
    readonly info: Readonly<HostInfo>
    private nativeModalDragRegion: boolean | null = null
    private readonly modalStyle: StyleReader

    constructor (sources: HostSources) {
        const xtermDeclaration = text(read(() => {
            const terminal = sources.terminalPackage?.() as {
                dependencies?: Record<string, unknown>, devDependencies?: Record<string, unknown>,
            } | undefined
            return text(terminal?.dependencies?.['@xterm/xterm']) ?? text(terminal?.devDependencies?.['@xterm/xterm'])
        }))
        this.info = Object.freeze({
            name: text(read(sources.name)), version: text(read(sources.version)), platform: text(sources.platform),
            electron: text(sources.electron), node: text(sources.node), xtermDeclaration,
            xtermMajor: declaredMajor(xtermDeclaration),
        })
        this.modalStyle = sources.modalStyle ?? ((element, pseudo) => getComputedStyle(element, pseudo))
    }

    /** Probe each modal; themes and UI scale can change while the application is running. */
    hasNativeModalDragRegion (modal: Element): boolean {
        let supported = false
        try {
            const style = this.modalStyle(modal, '::before')
            supported = style.content !== 'none' && style.content !== 'normal' && style.display !== 'none' &&
                style.getPropertyValue('-webkit-app-region') === 'drag' && parseFloat(style.height) > 0
        } catch { }
        this.nativeModalDragRegion = supported
        return supported
    }

    snapshot (pane?: ParentNode): HostSnapshot {
        return {
            ...this.info,
            capabilities: {
                nativeModalDragRegion: this.nativeModalDragRegion,
                terminalInput: pane ? terminalInputs(pane).length > 0 : null,
            },
        }
    }

    /** Local build information and observed capabilities only; no config, accounts, paths or connection details. */
    diagnosticLines (pane?: ParentNode): string[] {
        const info = this.snapshot(pane)
        const { nativeModalDragRegion, terminalInput } = info.capabilities
        const drag = nativeModalDragRegion === null ? 'unobserved' : nativeModalDragRegion ? 'host' : 'plugin fallback'
        const input = terminalInput === null ? 'unobserved' : terminalInput ? 'available' : 'unavailable'
        return [
            `Host: ${info.name ?? 'unknown'} ${info.version ?? 'unknown'} on ${info.platform ?? 'unknown'}`,
            `Runtime: Electron ${info.electron ?? 'unknown'}, Node ${info.node ?? 'unknown'}`,
            `Terminal: xterm ${info.xtermDeclaration ?? 'unknown'} (host declaration)`,
            `Compatibility: modal drag region ${drag}; terminal input ${input}`,
        ]
    }
}

/** Prefer Tabby's public version API; optional metadata reads never become requirements for operating a desktop. */
export function createHostCompatibility (platform: { getAppVersion (): string }): HostCompatibility {
    return new HostCompatibility({
        name: () => require('@electron/remote').app.getName(),
        version: () => platform.getAppVersion(),
        platform: process.platform, electron: process.versions.electron, node: process.versions.node,
        terminalPackage: () => require('tabby-terminal/package.json'),
    })
}
