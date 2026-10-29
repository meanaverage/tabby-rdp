// The helper build's targets and paths, also used by the package checks and their tests.
export interface Target {
    platform: string
    arch: string
    goos: string
    goarch: string
    goarm?: string
}
export const TARGETS: Target[]
export function helperFile (target: Pick<Target, 'platform' | 'arch'>): string
export const SUMS: string
export function wantedToolchain (root: string): string
