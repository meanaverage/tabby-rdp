# Contributing

Issues and pull requests are welcome. For anything larger than a fix, please open an issue first to talk it through.

## Layout

| Path | |
|---|---|
| `src/` | The plugin (TypeScript, Angular services, and one small tab component for RDP profiles). `index.ts` wires it into Tabby. |
| `remote/trd-pty.py` | The shared-session helper `desk` installs on the remote (Python 3 standard library). |
| `vendor/` | IronRDP's web client, built from `ironrdp/` (don't edit by hand). |
| `ironrdp/` | The IronRDP base commit and the patch series applied to it. |
| `test/` | End-to-end suites, their harness and runner, and trd-pty's own tests. |
| `testbed/` | Scripts to set up test machines. |
| `scripts/` | Development helpers: a separate Tabby for trying changes, and the IronRDP build. |
| `docs/` | Design notes and README images. |

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

## Style

Match the code around you: 4-space indentation, no semicolons in TypeScript, comments that explain why rather than
what. Commit messages: a short summary line, then what changed and why.
