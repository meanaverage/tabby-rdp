# tabby-rdp's FreeRDP helper

This package holds the FreeRDP helper of [tabby-rdp](https://github.com/meanaverage/tabby-rdp), the Tabby plugin for
Windows and Linux remote desktops, built for one platform. Its `package.json` says which.

Install tabby-rdp from Tabby's plugin list rather than this package. tabby-rdp names one of these packages for each
platform it supports, and npm installs the one that matches the computer along with the plugin. This package is not a
Tabby plugin and does nothing on its own.

It contains:

- `tabby-freerdp`, the helper that tabby-rdp runs for a desktop that uses the FreeRDP client, and the FreeRDP, WinPR and
  OpenSSL libraries it loads.
- `BUILD.json`: the FreeRDP and OpenSSL sources it was built from, with their SHA-256, and the hash of each file.
- `licenses/`: the licenses of FreeRDP, WinPR and OpenSSL (Apache-2.0), FreeRDP's notice, and WinPR's Unicode
  conversion notice. The helper's own code is MIT (`LICENSE`).

How the helper is built and released: `native/README.md` in [tabby-rdp's repository](https://github.com/meanaverage/tabby-rdp),
at [the tag](https://github.com/meanaverage/tabby-rdp/tags) of this package's version (`main` holds stable releases only).
