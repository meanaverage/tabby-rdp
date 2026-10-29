import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// Node built-ins only; this is the same script the credentialed workflow executes.
const script = import('../../scripts/release-plan.mjs' as string) as Promise<any>
const pkg = (version: string) => ({ name: 'tabby-rdp', version, tabbyRdp: { minimumTabbyVersion: '1.0.236', rollbackFloor: '0.5.1' } })

test('stable, beta and RC routing always retains a private GitHub draft until npm approval', async () => {
    const { releasePlan } = await script
    assert.deepEqual(releasePlan('v0.6.0', pkg('0.6.0')), { version: '0.6.0', npmTag: 'latest', prerelease: false, githubFlags: ['--draft', '--latest=false'] })
    for (const v of ['0.6.0-beta.1', '0.6.0-rc.2']) {
        const plan = releasePlan(`v${v}`, pkg(v))
        assert.equal(plan.npmTag, 'beta')
        assert.equal(plan.prerelease, true)
        assert.deepEqual(plan.githubFlags, ['--draft', '--latest=false', '--prerelease'])
    }
})

test('invalid tags, tag mismatches, held packages and missing policy cannot stage', async () => {
    const { releasePlan } = await script
    for (const v of ['0.6.0-beta', '0.6.0-alpha.1', '0.6.0-rc.01', '0.6.0+build', '00.6.0', '0.6.0;echo nope']) {
        assert.throws(() => releasePlan(`v${v}`, pkg(v)), /Release requires/)
    }
    assert.throws(() => releasePlan('v0.6.1', pkg('0.6.0')))
    assert.throws(() => releasePlan('v0.6.0', { ...pkg('0.6.0'), private: true }))
    assert.throws(() => releasePlan('v0.6.0', { ...pkg('0.6.0'), name: 'other' }))
    assert.throws(() => releasePlan('v0.6.0', { ...pkg('0.6.0'), tabbyRdp: undefined }), /declare/)
})

test('draft notes require an exact nonempty changelog and do not promise staged package availability', async () => {
    const { releasePlan, releaseNotes } = await script
    const plan = releasePlan('v0.6.0-rc.1', pkg('0.6.0-rc.1'))
    const notes = releaseNotes(plan, '## Unreleased\n\nLater\n\n## 0.6.0-rc.1\n\nTested change\n\n## 0.5.1\n\nOlder\n')
    assert.match(notes, /Unpublished draft/)
    assert.match(notes, /not available until/)
    assert.match(notes, /choose Preview/)
    assert.match(notes, /npm install tabby-rdp@0.6.0-rc.1/)
    assert.match(notes, /Tested change/)
    assert.doesNotMatch(notes, /Later|Older/)
    assert.doesNotMatch(notes, /Publish this|maintainer|After approval|replacing this paragraph/)
    assert.throws(() => releaseNotes(plan, '## 0.6.0\n\nWrong release'))
    assert.throws(() => releaseNotes(plan, '## 0.6.0-rc.1\n\n## 0.5.1\nOld'))
})

test('publishing workflow keeps every staging gate, explicit tags and draft availability boundary', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8')
    assert.match(workflow, /needs: \[ironrdp, package, helpers\]/)
    assert.match(workflow, /id-token: write/)
    assert.match(workflow, /sha256sum --strict -c -/)
    assert.match(workflow, /check-vendor\.mjs package/)
    // The package's network helpers are another system's build of them, byte for byte (their list's hash).
    assert.match(workflow, /check-vendor\.mjs package [^\n]*--helpers-sha256 "\$HELPERS"/)
    assert.match(workflow, /HELPERS: \$\{\{ needs\.helpers\.outputs\.sha256 \}\}/)
    assert.match(workflow, /npm stage publish[^\n]*--tag "\$npm_tag"[^\n]*--provenance --access public --ignore-scripts/)
    const creates = workflow.split('\n').filter(line => /gh release create/.test(line))
    assert.equal(creates.length, 2)
    for (const line of creates) {
        assert.match(line, /--verify-tag/)
        assert.match(line, /--draft/)
        assert.match(line, /--latest=false/)
    }
    assert.match(creates[0], /--prerelease/)
    assert.doesNotMatch(creates[1], /--prerelease/)
    assert.doesNotMatch(workflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n'), /npm (?:publish|stage approve)|gh release edit/)
})


test("a release stages each platform's FreeRDP package before the plugin, which names them, each from its pack", async () => {
    const { releasePackages } = await script
    const format4 = { ...pkg('0.6.0-rc.2'), tabbyRdp: { ...pkg('0.6.0-rc.2').tabbyRdp, packageFormat: 4, freerdpPlatforms: ['linux-x64', 'win32-arm64'] } }
    assert.deepEqual(releasePackages(format4), [
        { name: '@tabby-rdp/freerdp-linux-x64', file: 'tabby-rdp-freerdp-linux-x64-0.6.0-rc.2.tgz' },
        { name: '@tabby-rdp/freerdp-win32-arm64', file: 'tabby-rdp-freerdp-win32-arm64-0.6.0-rc.2.tgz' },
        { name: 'tabby-rdp', file: 'tabby-rdp-0.6.0-rc.2.tgz' },
    ])
    // Before format 4, the plugin alone.
    assert.deepEqual(releasePackages(pkg('0.5.7')), [{ name: 'tabby-rdp', file: 'tabby-rdp-0.5.7.tgz' }])
    const committed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    assert.equal(releasePackages(committed).length, committed.tabbyRdp.freerdpPlatforms.length + 1)
    // The workflow takes exactly these by hash, checks each, and stages them in this order.
    const workflow = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8')
    assert.equal(workflow.match(/node scripts\/release-plan\.mjs packages/g)?.length, 3)
    assert.match(workflow, /diff "\$RUNNER_TEMP\/expected" "\$RUNNER_TEMP\/listed"/)
})

test('preview migrations may set preview floors, but no floor may exceed its package', async () => {
    const { releasePlan } = await script
    const withFloor = (version: string, floor: string) => ({ ...pkg(version), tabbyRdp: { ...pkg(version).tabbyRdp, rollbackFloor: floor } })
    for (const [version, floor] of [['0.6.0-beta.1', '0.6.0-beta.1'], ['0.6.0-beta.10', '0.6.0-beta.2'], ['0.6.0-rc.1', '0.6.0-beta.10'], ['0.6.0', '0.6.0-rc.9']]) {
        assert.doesNotThrow(() => releasePlan(`v${version}`, withFloor(version, floor)))
    }
    for (const [version, floor] of [['0.6.0-beta.1', '0.6.0'], ['0.6.0-beta.2', '0.6.0-beta.10'], ['0.6.0-beta.10', '0.6.0-rc.1'], ['0.5.1', '0.6.0-beta.1']]) {
        assert.throws(() => releasePlan(`v${version}`, withFloor(version, floor)), /floor must not be newer/)
    }
})
