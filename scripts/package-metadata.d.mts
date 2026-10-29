// The built-in-only publication helper is also exercised by the TypeScript tests.
export const PACKAGE_FORMATS: number[]
export function runtimeMetadata (manifest: Record<string, unknown>, lock: Record<string, unknown>): {
    'package.json': Buffer
    /** Format 1 only. */
    'npm-shrinkwrap.json'?: Buffer
}
export function freeRDPPackage (platform: string): string
export function freeRDPPlatforms (manifest: Record<string, unknown>): string[]
export function freeRDPMetadata (manifest: Record<string, unknown>, platform: string): Buffer
export function freeRDPFiles (platform: string, built: string[]): [string, string][]
