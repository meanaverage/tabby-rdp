// Types for the test suites (test/suites/pdu-trace.ts); the module itself is plain JavaScript.
export interface TraceEventLike { seq: number, t: number, dir: string, layer: string, name: string, bytes: number, attrs: Record<string, any>, repeat?: number, until?: number }
export function readPluginTrace (file: string): { events: TraceEventLike[], startedAt: number, endedAt: number, meta: Record<string, any> }
export function parseFreeRdpLog (text: string, day: Date): TraceEventLike[]
export function merge (plugin: TraceEventLike[] | null | undefined, freerdp: TraceEventLike[]): TraceEventLike[]
