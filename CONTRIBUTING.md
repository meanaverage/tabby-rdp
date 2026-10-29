# Contributing

Issues and pull requests are welcome. For anything larger than a fix, please open an issue first to talk it through.

## Layout

| Path | |
|---|---|
| `src/` | The plugin (TypeScript, Angular services, and one small tab component for RDP profiles). `index.ts` wires it into Tabby. |
| `remote/trd-pty.py` | The shared-session helper `desk` installs on the remote (Python 3 standard library). |
| `vendor/` | IronRDP's web client and its WebAssembly, built from `ironrdp/` (don't edit by hand). |
| `ironrdp/` | The IronRDP base commit and the patch series applied to it. |
| `test/` | End-to-end suites, their harness and runner, and trd-pty's own tests. |
| `testbed/` | Scripts to set up test machines. |
| `scripts/` | Development helpers: a separate Tabby for trying changes, and the IronRDP build. |
| `docs/` | User guides, design notes, test coverage and README images. |

## How changes land

Everything goes through a pull request, including the maintainers' own work. During preview development, branch
from the active version branch named in [AGENTS.md](AGENTS.md) and target follow-up PRs there. `main` holds stable
releases only, so that a checkout of it is always a released, stable version: previews are tagged on their version
branch, and a version branch goes into `main` through a release-integration PR only for a stable release, after
maintainer approval. Push a branch (or fork), open a pull
request, and CI builds and packages the plugin, checks `vendor/` against the list its build wrote and the
package against the commit, runs trd-pty's tests, applies the IronRDP patch series and runs its web tests. When the
series, the IronRDP build or `vendor/` change, CI also rebuilds `vendor/` and compares it byte for byte, and runs the
patched crates' Rust tests ([ironrdp/README.md](ironrdp/README.md#reproducing-vendor)); those jobs don't run for every
pull request, so they can't be required checks, but a release runs them whatever changed and is made only if they pass
(below). The end-to-end suites need test machines, so they aren't in CI; say in the pull request which ones you ran.
`main` only changes by merging a pull request that CI passed. A preview release is a tag on its version branch, a
stable release a tag on `main` (below).

Prepare an isolated test package from the PR before release. A version such as `0.6.0-rc.1` can be prepared without
creating a release. Do not tag or publish until the maintainer explicitly approves the release after testing. A
stable version's release-integration PR stays a draft while analysis and the maintainer's hands-on testing remain,
and merges into `main` only after approval and passing checks. [AGENTS.md](AGENTS.md) records this procedure for
coding agents. After a preview is published, start the next preview branch from its tag and advance the package
version before making further changes, including documentation-only changes. Published tags and packages remain
immutable.

The pull request template has a short checklist, and the issue forms ask for what helps most with a connection
problem: versions, what kind of desktop, and the connection log (Settings › Remote Desktop › Desktops › Open desktops › Copy log).

Write public descriptions for reviewers and users who have not seen the development conversation. Explain the
problem, resulting behavior, relevant limitations and validation. Keep personal test setup, progress reports,
approval history and agent handoffs in the development conversation. Public installation instructions must work for
any reader. Read back saved GitHub descriptions and release notes before considering a copy update complete.

## Working on the plugin

```sh
npm install
npm run build          # or: npm run watch
npm run build:helper   # this computer's Go network helper for linked testing
scripts/sandbox.sh     # a separate Tabby with this checkout linked in (macOS); restart it to load a new build
```

Tabby loads plugins once, at start, so restart the sandbox after each build.

## Tests

The suites run against real machines; set up a Linux test host as described in [testbed/README.md](testbed/README.md),
then `npm test` ([test/README.md](test/README.md)). Please run the suites your change touches, and add checks for new
behavior. `npm test -- --packed` checks the plugin as npm would install it. The suites and their harness are
TypeScript; `npm run typecheck` checks the plugin and them (CI runs the build and `npm run typecheck:test`).
`npm run test:unit` and `npm run test:helper` need no test machine. The proxy tests verify TLS 1.2 ECDHE with a certificate
like Windows' default one. The Electron proxy test checks that Tabby's runtime starts the helper and carries direct,
SSH and gateway-like streams when `TRD_ELECTRON` names an
Electron binary that may run as Node (an app's with that fuse on, such as Visual Studio Code's `Contents/MacOS/Code`,
or the `electron` npm package's: `node -p "require('electron')"` in a folder where it is installed); without it, they
are skipped. CI runs them on Linux in the Electron of the Tabby release the plugin is qualified on.

The compatibility job uses a standalone patched Electron in `scripts/electron/package.json` and its own committed
lockfile, in addition to native smoke checks using Tabby's bundled runtime. This QA dependency does not update
Tabby or become a plugin dependency. Upgrade Electron there
with `npm install --package-lock-only --ignore-scripts --prefix scripts/electron electron@<exact-version> --save-exact`,
review all dependency and integrity changes, and run the proxy tests with that binary. CI installs this tree using
`npm ci --ignore-scripts`, then explicitly runs only Electron's locked binary installer, which checks the downloaded
archive against Electron's release checksums. The project does not install Electron as a plugin dependency.

`npm test -- helper` starts the helper in Tabby and tests its relay and crash recovery without a remote machine.
For a packed test, build every target first with `npm run build:helpers`, then run
`npm test -- --packed --hidden helper`.

For a Tabby host upgrade, run `npm run build` and then `npm run test:smoke -- --tabby <binary> --expect-xterm <major>`.
This checks a locally packed plugin in an isolated host profile, with dummy credential storage. Add `--require-rdp`
to require the live desktop checks. See [the host smoke instructions](test/README.md#host-upgrade-smoke-tests) for
coverage and the release/nightly test matrix.

For release controls, run `npm test -- --packed --hidden --tabby <binary> smoke-updates`.
It exercises cancellation, progress, failures and verified success using a simulated compatible release and disk
result, retaining the installed test package. See [test/README.md](test/README.md#package-change-smoke-tests).

## Host compatibility

[`src/hostCompat.ts`](src/hostCompat.ts) owns host identity, optional metadata reads, and host capability probes.
The plugin provides one `HostCompatibility` instance per window, available as `window.__remoteDesktop.compat` in
DevTools. `snapshot(paneElement?)` reports host/runtime versions and observed capabilities; `null` means unknown or
unobserved. Copied connection logs include its diagnostic lines.

Keep host workarounds and terminal DOM adapters here. Probe the feature being used rather than inferring it from
the application version: forks, nightlies and backports can have different features. Xterm information is the
terminal package's declared dependency, with an unknown major for ranges spanning majors; it is not a verified
runtime version. Modal capability is checked for every dialog, so theme and UI scale changes are respected.

## IronRDP

Changes to IronRDP go in the patch series, one focused patch per change, with tests where IronRDP has a place for
them; see [ironrdp/README.md](ironrdp/README.md). Fixes that belong upstream should also go to
[Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) as pull requests.

## Releasing

**When.** Changes accrue on the active version branch under its version's heading in CHANGELOG.md, marked unreleased
until then (the workflow also creates the GitHub release from that section once it is titled with the version). A release is cut when there is enough there to
be worth a user's update — a feature set, or a batch of fixes — not per change. Patch releases between those are for
security fixes and for bugs that make the plugin unusable; everything else waits. Features gather under the next
minor version (see the milestones).

**Runtime dependencies.** Pin runtime dependencies to exact versions in `package.json`; the package publishes no
shrinkwrap, so `package.json` alone decides what a user's npm installs. Packing refuses a runtime dependency that isn't
an exact version, isn't what the lock installs, or has dependencies of its own (whose ranges would float), and anything
else the lock would install at run time. The committed `package-lock.json` locks development and runtime dependencies
for `npm ci`; npm never publishes it. Build with Node 22.12 or newer on the Node 22 line (CI uses Node 22). Angular 21.2.25 is a development dependency used for type checking;
Tabby supplies Angular at runtime. The plugin uses TypeScript compilation, not Angular template compilation.

Build every network helper with `npm run build:helpers`, then create distributable packages with
`npm run pack:release -- --pack-destination <directory>`, not a direct `npm pack`.
The packer stages files without changing the checkout, removes development dependencies and every script but `test`
from the published manifest (the test script says how the tests run, from this repository; npm never runs it on
install, and scanners read it as the package having tests), and publishes no shrinkwrap (0.5.5's packages carried a runtime-only one; check-vendor still checks
those against it). Playwright and its browser installer helpers belong to QA, not
plugin installations. CI audits the complete development tree too; excluding tools from publication does not replace
keeping those tools patched. Upgrade dependencies through
a reviewed change, run `npm ci --ignore-scripts`, build, and check the packed package before releasing.

**Native helpers.** The plugin's package includes the Go network helper for macOS, Windows and Linux on supported
architectures. `scripts/build-helper.mjs --all` uses the pinned Go toolchain and records every binary in
`bin/SHA256SUMS`. The release workflow builds them on Linux and independently on macOS; the package check compares
their lists byte for byte. Before approving an npm stage, rebuild the helpers from the release tag and compare its
`bin/SHA256SUMS` to the staged package. The FreeRDP helper is published in a package per
platform, `@tabby-rdp/freerdp-<platform>` (`linux-x64`, say), made from the committed `native/bin/<platform>` for each
platform in `tabbyRdp.freerdpPlatforms`. The published `package.json` names each one as an optional dependency at the
plugin's own version, so npm installs only the one for the computer, along with the plugin. The committed `package.json`
names none, so the lock never has to resolve packages that are published with the release (package format 5,
`scripts/package-metadata.mjs`). `pack:release` makes all of them: the plugin's package first, then one per platform. To
try an unreleased build, install the plugin's package together with the one for the computer, in Tabby's plugin folder:
`npm install ./tabby-rdp-<version>.tgz ./tabby-rdp-freerdp-<platform>-<version>.tgz`. On its own, the plugin's package
installs without the helper, since npm finds no such version on the registry; FreeRDP then reports the helper missing.

**Version metadata.** Keep `package.json` and the root entries in `package-lock.json` on the same version. The
`tabbyRdp.minimumTabbyVersion` and `tabbyRdp.rollbackFloor` fields let release controls check compatibility and data
migration limits; raise the floor only for a migration that prevents older packages from safely using the saved
data. Version 0.5.1 is the explicitly supported baseline for packages that predate these fields.
Preview versions use `<version>-beta.<number>` or `<version>-rc.<number>`. Both use npm's `beta` tag, which the
plugin's Preview channel follows; stable versions use `latest`. The release workflow validates this routing and
compatibility policy before staging. A candidate can be built with `npm run pack:release` without creating or pushing a tag.

**How.** Pushing a tag `v<version>` (matching `version` in package.json) runs [`publish.yml`](.github/workflows/publish.yml),
which builds the package and **stages** it on npm, with provenance. It goes live once a maintainer approves it: on
npmjs.com, the package's **Staged Packages** tab › **Approve**, or `npm stage approve <stage-id>` (both need two-factor
authentication). The workflow publishes `vendor/` as committed in the tagged commit, once it has rebuilt it from the
series and found it identical and the patched crates' tests have passed (`ironrdp.yml`; without that, the package
isn't staged, nor the GitHub release created). So run `npm run build:ironrdp` on an Apple Silicon Mac and commit its
output, `vendor/SHA256SUMS` included, before tagging if the patches changed (it needs the network: it checks the base
commit against IronRDP's history, even with IronRDP and the tools already there). The package is built in a job of its
own, which reports the package's SHA-256; the job that stages it takes the package by that hash (any job of the run
can replace an artifact, the IronRDP jobs with their many builds and tests included), and checks it against the tagged
commit: `vendor/` as the commit's `vendor/SHA256SUMS` lists it, the two runtime metadata files as deterministically
derived from the committed sources, every other file but `dist/` as committed, and nothing more. `dist/` is as the
package job built it: nothing in the workflow checks it against another build. The FreeRDP packages go the same way,
each taken by its hash and checked against the tag (`native/bin/<platform>` as committed, the README and license, and
`package.json` as derived from the committed one). They are staged before the plugin, and a failure leaves the plugin
unstaged. Approve them before the plugin: until they are live, an installation of the plugin goes without its helper.

That check runs in the job that publishes, which can't vouch for itself (its Node.js and npm are whatever their download
served for 26.8.2), and a package's own `vendor/SHA256SUMS` can't vouch for the package. So before approving, check the
staged package against the tag in your own checkout (`git fetch --tags` first), with the same script, and its `dist/`
against a build of your own:

```sh
npm stage download <stage-id>     # saves tabby-rdp-<version>-<stage-id>.tgz
git worktree add /tmp/tabby-rdp-v<version> v<version>     # the tag, built here: tabby-rdp-<version>.tgz
(cd /tmp/tabby-rdp-v<version> && npm ci --ignore-scripts && npm run build && npm run build:helpers && npm run pack:release)
node scripts/check-vendor.mjs package tabby-rdp-<version>-<stage-id>.tgz --same-as /tmp/tabby-rdp-v<version>/tabby-rdp-<version>.tgz
```

Check each staged FreeRDP package the same way, against the one your build of the tag made
(`/tmp/tabby-rdp-v<version>/tabby-rdp-freerdp-<platform>-<version>.tgz`). Nothing in those is built, so the check
against the tag alone covers every file; `--same-as` adds nothing but costs nothing either.

The workflow creates a GitHub draft; preview versions also carry the prerelease flag and cannot become latest.
After npm approval, verify the published version and its dist-tag, remove the draft's unpublished notice, check
the installation instructions and release notes for their public audience, and publish the draft. Mark only a
stable release as GitHub's latest release.

It finds the tag by the package's version and reads the list and the files from git, never from the package; any file
the tag doesn't have, or has otherwise (apart from the declared runtime metadata projection), or a `vendor/` file
missing, fails it, as does a tarball other than the plain kind npm pack writes: one gzip member that ends where the file does, holding plain tar, files only (a folder entry
fails, an extractor makes a folder at its path) and ending in its empty blocks (gzip and tar readers differ on the rest,
and npm's could install files the check never saw). `dist/` is built, so only another build can vouch for it:
`--same-as` compares every file of the two packages, `dist/` included. It is the only check of `dist/` that doesn't take
the package job's word for it.

The workflow authenticates with npm trusted publishing (OIDC, no token to keep). One-time setup, by a maintainer of
the package on npmjs.com: the package's **Settings › Trusted publishing**, choose **GitHub Actions**, and enter
owner/user `meanaverage`, repository `tabby-rdp`, workflow filename `publish.yml` (no environment). Leave "publish
directly" unchecked: the workflow only stages. After a first release that way, **Settings › Publishing access** can be
set to require two-factor authentication and disallow tokens.

Trusted publishing can only be set up for a package that exists, so a new FreeRDP package (a new platform, or all of
them the first time) has its first version published by hand, before the tag is pushed. The packages belong to the npm
organization `tabby-rdp`, which a maintainer creates once (npmjs.com, **Add Organization**, free for public packages).
From your build of the release commit, check each new package against the commit, then publish it with two-factor
authentication; its `package.json` makes it public. Then set up its trusted publishing as above:

```sh
node scripts/check-vendor.mjs package tabby-rdp-freerdp-<platform>-<version>.tgz HEAD
npm publish tabby-rdp-freerdp-<platform>-<version>.tgz --tag beta    # latest for a stable version
```

A version published by hand has no provenance. When the workflow finds a FreeRDP package's version already on npm, it
downloads it and checks it against the tag instead of staging it; if that check fails, nothing is staged.

## Actions

The internal-name check receives `INTERNAL_NAMES` only on pushes to protected branches. Pull requests and
unprotected branches skip that job. Keep the release and main branches protected; the check reports file names and
line numbers, and removes its temporary pattern and match files when it exits. This workflow condition limits
routine exposure, but anyone permitted to edit workflows on a branch can change it: restrict repository write
access, and use an environment secret with protected deployment branches if writers are not all trusted.

Linux jobs use `ubuntu-24.04` so changes to GitHub's `ubuntu-latest` alias do not silently move CI or publication
to a new Ubuntu release. Upgrade the runner version deliberately and validate the workflows before merging. The
IronRDP rebuild remains on an Apple Silicon Mac to match the committed build.

The workflows pin each action to a commit, with its version in a comment (`actions/checkout@<commit> # v7.0.1`): a
tag can be moved to other code, a commit can't. Dependabot ([`.github/dependabot.yml`](.github/dependabot.yml))
proposes newer versions as pull requests that change both; review them as any other change. To move by hand, look up
the commit the tag names (`git ls-remote https://github.com/actions/checkout refs/tags/v4.4.1 'refs/tags/v4.4.1^{}'`;
for an annotated tag, the line ending in `^{}` is the commit, and it shows only when asked for by name), and change the
commit and the comment together, in every workflow that uses the action. The publish job's Node.js is an exact version
for the same reason, and the npm that publishes is the one that comes with it (Node.js 26.8.2's is 11.19.1; staged
publishing needs 11.15.0 or later), so npm is no download of its own from the registry; raise it on purpose, to a
Node.js whose npm is new enough (its changelog says which npm it has). An exact version keeps out a newer release, not
other bytes served under the same one: the check of a staged package before approving it (above) is what doesn't
depend on them. Checkouts don't keep the job's token in git's configuration, and only the publish job can get the
token npm trusts; it runs none of the dependencies' code.

The Dependabot config also defines npm updates for the plugin. The Electron compatibility test's separate dependency
tree stays pinned to an explicitly reviewed version. Validate changes with its proxy tests and the native Tabby smoke
checks; a standalone Electron result does not qualify a different Tabby host. GitHub reads
this config from the default branch; once it is there, version-update PRs target the active preview branch. Advance
`target-branch` when that branch changes. GitHub always sends security-update PRs to the default branch. A security
fix found on `main` must be carried through the active preview and the release process above rather than merged
directly into stable `main` between releases.

## Style

Match the code around you: 4-space indentation, no semicolons in TypeScript, comments that explain why rather than
what. Commit messages: a short summary line, then what changed and why.
