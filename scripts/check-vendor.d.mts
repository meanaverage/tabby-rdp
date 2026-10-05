// Types of scripts/check-vendor.mjs, for the unit tests (test/unit/vendor.ts) that run it. The script is plain
// JavaScript so that it runs with Node.js alone, where no dependency should (the job that publishes).
export const UPSTREAM: string
export const MANIFEST: string
export function sha256 (data: Buffer | string): string
export function parseManifest (text: string): Map<string, string>
export function isText (file: string): boolean
export function sameFile (file: string, data: Buffer, hash: string): boolean
export function walk (root: string, dir: string): { files: string[], odd: string[] }
export function checkTree (root: string): { unlisted: string[], missing: string[], changed: string[], odd: string[] }
export function tree (root: string, revision: string, dir?: string): Map<string, { mode: string, type: string, oid: string }>
export function compareRebuilt (root: string, revision?: string): {
    files: { file: string, committed: string | null, rebuilt: string | null, same: boolean }[]
    odd: string[]
    listDifferences: string[]
    same: boolean
}
export function readTarball (file: string): { path: string, type: string, data: Buffer }[]
export function packageFiles (tarball: string, problems: string[]): Map<string, Buffer>
export function checkPackage (root: string, tarball: string, options?: { revision?: string, sameAs?: string }): {
    problems: string[]
    revision: string
    commit: string
    version: string | null
    files: number
    vendor: number
    built: number
}
export function checkBase (root: string, options?: { upstream?: string, branch?: string }): { commit: string, upstream: boolean }
