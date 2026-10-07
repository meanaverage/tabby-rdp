// Node built-ins only: also runs in the trusted publishing job, without installing dependencies.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function releasePlan (tag, pkg) {
    const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
    const preview = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(beta|rc)\.(0|[1-9]\d*)$/
    const version = pkg.version
    if (pkg.name !== 'tabby-rdp' || pkg.private === true || typeof version !== 'string' ||
        (!stable.test(version) && !preview.test(version)) || tag !== `v${version}`) {
        throw new Error('Release requires a matching vX.Y.Z or vX.Y.Z-beta.N / vX.Y.Z-rc.N tag and a public tabby-rdp package.')
    }
    const floor = pkg.tabbyRdp?.rollbackFloor ?? ''
    if (!stable.test(pkg.tabbyRdp?.minimumTabbyVersion ?? '') || (!stable.test(floor) && !preview.test(floor))) {
        throw new Error('Review and declare tabbyRdp.minimumTabbyVersion and tabbyRdp.rollbackFloor before releasing.')
    }
    // Our intentionally narrow grammar makes dependency-free SemVer ordering small and auditable.
    // Compare decimal components as BigInt, never lossy Number values. Stable follows RC, which follows beta.
    const parts = value => {
        const [core, pre] = value.split('-')
        const [kind, n] = pre?.split('.') ?? []
        return [...core.split('.').map(BigInt), BigInt(!pre ? 2 : kind === 'rc' ? 1 : 0), BigInt(n ?? 0)]
    }
    const a = parts(floor), b = parts(version)
    const different = a.findIndex((part, i) => part !== b[i])
    if (different >= 0 && a[different] > b[different]) {
        throw new Error('The rollback floor must not be newer than the package version.')
    }
    const prerelease = preview.test(version)
    return { version, npmTag: prerelease ? 'beta' : 'latest', prerelease,
        // npm approval is still outstanding. Neither kind is public/latest on GitHub until the maintainer verifies it.
        githubFlags: ['--draft', '--latest=false', ...(prerelease ? ['--prerelease'] : [])] }
}

export function releaseNotes (plan, changelog) {
    const marker = `## ${plan.version}`
    const lines = changelog.split('\n')
    const start = lines.indexOf(marker)
    if (start < 0) { throw new Error(`CHANGELOG.md has no section '${marker}'`) }
    const next = lines.findIndex((line, i) => i > start && /^## /.test(line))
    const changes = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim()
    if (!changes) { throw new Error('The release changelog is empty.') }
    return `**Draft: awaiting npm approval.** This version is not available until a maintainer approves the staged package and verifies it on npm. Publish this GitHub draft only after that check, replacing this paragraph with the installation instructions below.\n\n` +
        `**After approval:** In Tabby, open Settings › Remote Desktop › Updates${plan.prerelease ? ', choose Preview,' : ''} and select ${plan.version}. For recovery, run \`npm install tabby-rdp@${plan.version}\` in Tabby's plugin folder. Restart Tabby afterwards.\n\n${changes}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const plan = releasePlan(process.env.GITHUB_REF_NAME, JSON.parse(readFileSync('package.json', 'utf8')))
    switch (process.argv[2]) {
        case 'npm-tag': console.log(plan.npmTag); break
        case 'github-flags': console.log(plan.githubFlags.join(' ')); break
        case 'notes': process.stdout.write(releaseNotes(plan, readFileSync('CHANGELOG.md', 'utf8'))); break
        case 'check': console.log(`${plan.version}: npm ${plan.npmTag}, GitHub draft${plan.prerelease ? ' prerelease' : ''}`); break
        default: throw new Error('Expected check, npm-tag, github-flags, or notes')
    }
}
