# TLS-only cached bitmap regression peer

`native/pam-test-server.c` sends legacy drawing orders over TLS without NLA. It paints a control image, repaints
black, then fills the desktop with cached bitmap tiles containing opaque, zero, partial or omitted alpha, plus a
true-black control. It reports whether the synthetic bracketed PAM username arrived intact. It never validates a
real account and never connects to another server. Its default listener is loopback; an explicit bind address is
available for isolated VM-to-VM testing. Every peer has a 15-second watchdog after accepting a connection.

After the pinned native CI build, `node scripts/build-pam-fixture.mjs` builds the peer separately from the production
bundle. CI retains the executable alongside the native bundle. `controller.cjs` starts one peer at a time and
returns its port. Run it only on a disposable test server, restrict its firewall to the test client, and supply
`TRD_PAM_BIND`, `TRD_PAM_CLIENT`, `TRD_PAM_SERVER`, `TRD_PAM_CERT` and `TRD_PAM_KEY`. The controller's HTTP port defaults
to 8766. The test certificate and key are synthetic; never pass real credentials to this peer.

On the client, set `TRD_PAM_CONTROLLER`, an independently verified `TRD_PAM_FINGERPRINT`, and optionally
`TRD_PAM_OUTPUT`, then run `node --import tsx test/run.ts freerdp-pam`. The suite exercises both runtimes through
Tabby's actual canvas, all combinations of glyph caching/bitmap caching/relaxed checks, and the alpha variants
when bitmap caching is enabled. Bitmap caching disabled with strict checks is a negative case: those unannounced
orders must be refused. Native/WASM results are compared case by case.

This tests protocol and renderer behavior related to PAM compatibility. It does not emulate Senhasegura's login
widgets, MFA, appliance policies or handoff to a target session, and cannot certify those flows.
