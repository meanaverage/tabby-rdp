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
open a pull request, and CI builds and packages the plugin, runs trd-pty's tests, applies the IronRDP patch series and
runs its web tests. The end-to-end suites need test machines, so they aren't in CI; say in the pull request which ones
you ran. `main` only changes by merging a pull request that CI passed. Releases are tags on `main` (below).

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
behavior. `npm test -- --packed` checks the plugin as npm would install it.

## IronRDP

Changes to IronRDP go in the patch series, one focused patch per change, with tests where IronRDP has a place for
them; see [ironrdp/README.md](ironrdp/README.md). Fixes that belong upstream should also go to
[Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) as pull requests.

## Releasing

Pushing a tag `v<version>` (matching `version` in package.json) runs [`publish.yml`](.github/workflows/publish.yml),
which builds the package and **stages** it on npm, with provenance. It goes live once a maintainer approves it: on
npmjs.com, the package's **Staged Packages** tab › **Approve**, or `npm stage approve <stage-id>` (both need two-factor
authentication). The workflow publishes `vendor/` as committed in the tagged commit (CI does not rebuild IronRDP), so
run `npm run build:ironrdp` and commit its output before tagging if the patches changed.

The workflow authenticates with npm trusted publishing (OIDC, no token to keep). One-time setup, by a maintainer of
the package on npmjs.com: the package's **Settings › Trusted publishing**, choose **GitHub Actions**, and enter
owner/user `meanaverage`, repository `tabby-rdp`, workflow filename `publish.yml` (no environment). Leave "publish
directly" unchecked: the workflow only stages. After a first release that way, **Settings › Publishing access** can be
set to require two-factor authentication and disallow tokens.

## Style

Match the code around you: 4-space indentation, no semicolons in TypeScript, comments that explain why rather than
what. Commit messages: a short summary line, then what changed and why.
