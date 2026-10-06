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
| `docs/` | Design notes and README images. |

## How changes land

Everything goes through a pull request against `main`, including the maintainers' own work: push a branch (or fork),
open a pull request, and CI builds and packages the plugin, checks `vendor/` against the list its build wrote and the
package against the commit, runs trd-pty's tests, applies the IronRDP patch series and runs its web tests. When the
series, the IronRDP build or `vendor/` change, CI also rebuilds `vendor/` and compares it byte for byte, and runs the
patched crates' Rust tests ([ironrdp/README.md](ironrdp/README.md#reproducing-vendor)); those jobs don't run for every
pull request, so they can't be required checks, but a release runs them whatever changed and is made only if they pass
(below). The end-to-end suites need test machines, so they aren't in CI; say in the pull request which ones you ran.
`main` only changes by merging a pull request that CI passed. Releases are tags on `main` (below).

The pull request template has a short checklist, and the issue forms ask for what helps most with a connection
problem: versions, what kind of desktop, and the connection log (Settings › Remote Desktop › Open desktops › Copy log).

## Working on the plugin

```sh
npm install
npm run build          # or: npm run watch
scripts/sandbox.sh     # a separate Tabby with this checkout linked in (macOS); restart it to load a new build
```

Tabby loads plugins once, at start, so restart the sandbox after each build.

## Tests

The suites run against real machines; set up a Linux test host as described in [testbed/README.md](testbed/README.md),
then `npm test` ([test/README.md](test/README.md)). Please run the suites your change touches, and add checks for new
behavior. `npm test -- --packed` checks the plugin as npm would install it. The suites and their harness are
TypeScript; `npm run typecheck` checks the plugin and them (CI runs the build and `npm run typecheck:test`).
`npm run test:unit` runs the unit tests, which need no test machine. Two of them run the plugin's proxy in Electron,
whose TLS library is the one Tabby has (the fallback for Windows' own certificate, and why the certificate question
says a certificate isn't valid), when `TRD_ELECTRON` names an Electron binary that may run as Node (an app's with that
fuse on, such as Visual Studio Code's `Contents/MacOS/Code`); without it, they are skipped.

For a Tabby host upgrade, run `npm run build` and then `npm run test:smoke -- --tabby <binary> --expect-xterm <major>`.
This checks a locally packed plugin in an isolated host profile, with dummy credential storage. Add `--require-rdp`
to require the live desktop checks. See [the host smoke instructions](test/README.md#host-upgrade-smoke-tests) for
coverage and the release/nightly test matrix.

## IronRDP

Changes to IronRDP go in the patch series, one focused patch per change, with tests where IronRDP has a place for
them; see [ironrdp/README.md](ironrdp/README.md). Fixes that belong upstream should also go to
[Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) as pull requests.

## Releasing

**When.** Changes accrue on `main` under an **Unreleased** heading in CHANGELOG.md (the workflow also creates the
GitHub release from that section once it is titled with the version). A release is cut when there is enough there to
be worth a user's update — a feature set, or a batch of fixes — not per change. Patch releases between those are for
security fixes and for bugs that make the plugin unusable; everything else waits. Features gather under the next
minor version (see the milestones).

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
commit: `vendor/` as the commit's `vendor/SHA256SUMS` lists it, every other file but `dist/` as committed, and nothing
more. `dist/` is as the package job built it: nothing in the workflow checks it against another build.

That check runs in the job that publishes, which can't vouch for itself (its Node.js and npm are whatever their download
served for 26.8.2), and a package's own `vendor/SHA256SUMS` can't vouch for the package. So before approving, check the
staged package against the tag in your own checkout (`git fetch --tags` first), with the same script, and its `dist/`
against a build of your own:

```sh
npm stage download <stage-id>     # saves tabby-rdp-<version>-<stage-id>.tgz
git worktree add /tmp/tabby-rdp-v<version> v<version>     # the tag, built here: tabby-rdp-<version>.tgz
(cd /tmp/tabby-rdp-v<version> && npm ci --ignore-scripts && npm run build && npm pack --ignore-scripts)
node scripts/check-vendor.mjs package tabby-rdp-<version>-<stage-id>.tgz --same-as /tmp/tabby-rdp-v<version>/tabby-rdp-<version>.tgz
```

It finds the tag by the package's version and reads the list and the files from git, never from the package; any file
the tag doesn't have, or has otherwise, or a `vendor/` file missing, fails it, as does a tarball other than the plain
kind npm pack writes: one gzip member that ends where the file does, holding plain tar, files only (a folder entry
fails, an extractor makes a folder at its path) and ending in its empty blocks (gzip and tar readers differ on the rest,
and npm's could install files the check never saw). `dist/` is built, so only another build can vouch for it:
`--same-as` compares every file of the two packages, `dist/` included. It is the only check of `dist/` that doesn't take
the package job's word for it.

The workflow authenticates with npm trusted publishing (OIDC, no token to keep). One-time setup, by a maintainer of
the package on npmjs.com: the package's **Settings › Trusted publishing**, choose **GitHub Actions**, and enter
owner/user `meanaverage`, repository `tabby-rdp`, workflow filename `publish.yml` (no environment). Leave "publish
directly" unchecked: the workflow only stages. After a first release that way, **Settings › Publishing access** can be
set to require two-factor authentication and disallow tokens.

## Actions

The workflows pin each action to a commit, with its version in a comment (`actions/checkout@<commit> # v4.4.0`): a
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

## Style

Match the code around you: 4-space indentation, no semicolons in TypeScript, comments that explain why rather than
what. Commit messages: a short summary line, then what changed and why.
