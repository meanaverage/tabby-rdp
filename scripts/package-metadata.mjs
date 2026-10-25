// Deterministic publication metadata. Build/test dependencies stay in the checkout;
// consumers install only the plugin's reviewed runtime dependency tree.
//
// Format 1 (0.5.5): package.json without development metadata, and a runtime-only npm-shrinkwrap.json projected
// from the committed one.
// Format 2 (0.5.6): package.json without development metadata, and no shrinkwrap: every runtime dependency is pinned to
// an exact version and has no dependencies of its own (the lock says so), so package.json alone fixes what is
// installed. The development lock is package-lock.json, which npm never publishes.
// Format 3: format 2, and package.json keeps its test script, the one script it publishes: how the tests run, from the
// source repository (they aren't in the package), which scanners read as the package having tests (Socket's "No tests"
// came with format 2's package.json, which publishes no scripts). npm never runs it when the package is installed;
// install, build and other lifecycle scripts stay out.
// Format 4: format 3, and the FreeRDP helper is published apart from the plugin, in a package per platform
// (@tabby-rdp/freerdp-<platform>, made from native/bin/<platform>; see freeRDPMetadata and freeRDPFiles). The published
// package.json names each one in tabbyRdp.freerdpPlatforms as an optional dependency, pinned to the plugin's own version:
// npm installs the one that matches the computer, and the plugin's package holds no native code. The committed
// package.json names none, so that the lock never has to resolve packages that are published with the release.
export const PACKAGE_FORMATS = [1, 2, 3, 4]

const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

/** The npm package that holds the FreeRDP helper for a platform (`linux-x64`, say). src/freerdp.ts names it the same. */
export const freeRDPPackage = platform => `@tabby-rdp/freerdp-${platform}`

/** tabbyRdp.freerdpPlatforms, checked: each a platform that npm tells apart by its os and cpu, and each once. */
export function freeRDPPlatforms (manifest) {
    const platforms = manifest.tabbyRdp?.freerdpPlatforms
    if (!Array.isArray(platforms) || platforms.length === 0 || new Set(platforms).size !== platforms.length ||
        platforms.some(platform => typeof platform !== 'string' || !/^(darwin|linux|win32)-(arm64|x64)$/.test(platform))) {
        throw new Error('Expected tabbyRdp.freerdpPlatforms: platforms such as linux-x64, each once')
    }
    return platforms
}

/** package.json of a platform's FreeRDP package, as published with the plugin's (committed) `manifest`. */
export function freeRDPMetadata (manifest, platform) {
    if (!freeRDPPlatforms(manifest).includes(platform)) {
        throw new Error(`${platform} is not in tabbyRdp.freerdpPlatforms`)
    }
    const [os, cpu] = platform.split('-')
    const pkg = {
        name: freeRDPPackage(platform),
        version: manifest.version,
        description: `tabby-rdp's FreeRDP helper for ${platform}. tabby-rdp installs it; it is not a Tabby plugin.`,
        homepage: manifest.homepage,
        // npm's provenance check holds the repository to the one the release workflow ran in.
        repository: manifest.repository,
        bugs: manifest.bugs,
        author: manifest.author,
        // The helper's own code is MIT; FreeRDP, WinPR and OpenSSL are Apache-2.0 (licenses/ in the package).
        license: 'MIT AND Apache-2.0',
        os: [os],
        cpu: [cpu],
        // The Linux builds link against glibc (native/README.md): npm leaves them out where it is not the C library.
        ...os === 'linux' ? { libc: ['glibc'] } : {},
        // Scoped packages are private unless published otherwise, a first publish by hand (CONTRIBUTING.md) included.
        publishConfig: { access: 'public' },
    }
    return Buffer.from(JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * What a platform's FreeRDP package holds besides its package.json: each path in the package, and the committed file it
 * is. `built` lists native/bin/<platform>'s files (paths within it), which go at the package's root, where the helper
 * finds its libraries.
 */
export function freeRDPFiles (platform, built) {
    const files = [
        ['README.md', 'native/package/README.md'],
        ['LICENSE', 'LICENSE'],
        ...built.map(file => [file, `native/bin/${platform}/${file}`]),
    ]
    const names = files.map(([name]) => name.toLowerCase())
    if (names.includes('package.json') || new Set(names).size !== names.length) {
        throw new Error(`native/bin/${platform} has a file the package keeps for its own (package.json, README.md or LICENSE)`)
    }
    return files
}

/** What a lock says of the package itself agrees with the manifest: name, version and runtime dependencies. */
function agrees (manifest, lock) {
    return lock.lockfileVersion === 3 && lock.name === manifest.name && lock.version === manifest.version &&
        lock.packages?.['']?.version === manifest.version &&
        JSON.stringify(lock.packages[''].dependencies ?? {}) === JSON.stringify(manifest.dependencies ?? {})
}

/** package.json as published: without development dependencies or scripts, but its test script with `keepTest`. */
function withoutDevelopment (manifest, keepTest = false) {
    const pkg = structuredClone(manifest)
    delete pkg.devDependencies
    const test = manifest.scripts?.test
    if (keepTest && typeof test === 'string' && test) {
        // In its place in the manifest: only the scripts' contents change.
        pkg.scripts = { test }
    } else {
        delete pkg.scripts
    }
    return Buffer.from(JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * The published metadata files for `manifest` (package.json as committed), given the committed lock: format 1's
 * shrinkwrap, later formats' package-lock.json.
 */
export function runtimeMetadata (manifest, lock) {
    const format = manifest.tabbyRdp?.packageFormat
    if (!PACKAGE_FORMATS.includes(format)) {
        throw new Error(`Expected tabbyRdp.packageFormat ${PACKAGE_FORMATS.join(' or ')}`)
    }
    if (!lock || !agrees(manifest, lock)) {
        throw new Error(`Runtime package and ${format === 1 ? 'shrinkwrap' : 'lock'} metadata disagree`)
    }
    if (format === 1) {
        const runtimeLock = structuredClone(lock)
        delete runtimeLock.packages[''].devDependencies
        for (const [name, entry] of Object.entries(runtimeLock.packages)) {
            if (name && entry.dev === true) {
                delete runtimeLock.packages[name]
            }
        }
        return {
            'package.json': withoutDevelopment(manifest),
            'npm-shrinkwrap.json': Buffer.from(JSON.stringify(runtimeLock, null, 2) + '\n'),
        }
    }
    // Without a published lock, nothing but the manifest decides what is installed: each runtime dependency exact,
    // as the lock has it, and none with dependencies of its own (whose ranges would float).
    const dependencies = Object.entries(manifest.dependencies ?? {})
    for (const [name, version] of dependencies) {
        if (!EXACT.test(version)) {
            throw new Error(`Runtime dependency ${name} is ${version}: pin it to an exact version`)
        }
        const locked = lock.packages[`node_modules/${name}`]
        if (!locked || locked.version !== version || locked.dev === true) {
            throw new Error(`Runtime dependency ${name} ${version} is not what the lock installs`)
        }
        if (Object.keys(locked.dependencies ?? {}).length || Object.keys(locked.optionalDependencies ?? {}).length) {
            throw new Error(`Runtime dependency ${name} has dependencies of its own, which package.json can't pin`)
        }
    }
    for (const [name, entry] of Object.entries(lock.packages)) {
        if (name && entry.dev !== true && entry.devOptional !== true && !dependencies.some(([dependency]) => name === `node_modules/${dependency}`)) {
            throw new Error(`${name} is installed at run time but isn't a pinned runtime dependency`)
        }
    }
    const published = withoutDevelopment(manifest, format >= 3)
    if (format < 4) {
        return { 'package.json': published }
    }
    if (manifest.optionalDependencies !== undefined) {
        throw new Error('package.json names optional dependencies: format 4 derives them, the FreeRDP packages, from tabbyRdp.freerdpPlatforms')
    }
    // The FreeRDP packages, after the runtime dependencies (or last), each at the plugin's version.
    const optionalDependencies = Object.fromEntries(freeRDPPlatforms(manifest).map(platform => [freeRDPPackage(platform), manifest.version]))
    const pkg = {}
    for (const [key, value] of Object.entries(JSON.parse(published.toString('utf8')))) {
        pkg[key] = value
        if (key === 'dependencies') {
            pkg.optionalDependencies = optionalDependencies
        }
    }
    pkg.optionalDependencies ??= optionalDependencies
    return { 'package.json': Buffer.from(JSON.stringify(pkg, null, 2) + '\n') }
}
