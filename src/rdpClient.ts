/** Saved names are independent of the order of the choices in the UI. */
export type RDPClient = 'ironrdp' | 'freerdp' | 'freerdp-wasm'

export const RDP_CLIENT_LABELS: Record<RDPClient, string> = {
    ironrdp: 'IronRDP',
    freerdp: 'FreeRDP native (experimental)',
    'freerdp-wasm': 'FreeRDP WebAssembly (experimental)',
}

/** An absent or invalid override follows the global setting. Existing installations keep IronRDP. */
export function ownRDPClient (value: unknown): RDPClient | undefined {
    return value === 'ironrdp' || value === 'freerdp' || value === 'freerdp-wasm' ? value : undefined
}

export function rdpClient (value: unknown): RDPClient {
    return ownRDPClient(value) ?? 'ironrdp'
}

/** Both clients keep their canvas in a shadow root, whose host is document.activeElement. */
export function isRDPElement (element: Element | null | undefined): boolean {
    return element?.tagName === 'IRON-REMOTE-DESKTOP' || !!element?.classList?.contains?.('trd-freerdp')
}
