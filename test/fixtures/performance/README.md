# FreeRDP native / WebAssembly comparison

Use two dedicated Windows VMs. Run `desktop.ps1` in the RDP server account's interactive session, then run the
`freerdp-benchmark` suite in Tabby on the client VM. The same FreeRDP version, 1280×800 resolution, bitmap path,
server account and workload are used for both runtimes. Native binaries remain developer comparison artifacts;
the benchmark selects each runtime directly through the production adapter and canvas.

Set `TRD_TEST_DIRECT`, `TRD_TEST_DIRECT_USER`, `TRD_TEST_DIRECT_PASSWORD`, the independently verified
`TRD_TEST_CERT_SHA256`, and `TRD_BENCH_OUTPUT`. Build the plugin, then:

```powershell
node --import tsx test/run.ts freerdp-benchmark
```

The default is three pairs with 20 seconds of motion per attempt, followed by 12 input samples and five seconds
idle. Pair order alternates native/WASM and WASM/native. Both normal settings and glyph caching, bitmap caching
and relaxed order checks together are measured. `TRD_BENCH_SECONDS` and `TRD_BENCH_PAIRS` allow a short fixture
check before the measured run. Keep other tasks off the client and server during measurements.

The workload paints a binary frame counter and a color patch that changes on F6. The client samples the counter
with animation callbacks. The frame metric counts distinct workload frames observed at the canvas, not RDP tiles,
and is not a measurement of the monitor's physical presentation. Input latency runs from sending F6 through the
production input adapter to observing the changed pixel; it includes network/server work and sampling quantization.
F7 pauses motion, F8 resumes, and Escape closes the workload.

Run `resources.ps1 -Output <jsonl> -StopFile <path>` alongside the client and create its stop file afterward. This
records all Tabby processes, including the WASM utility process, and native FreeRDP children. Use a dedicated VM
with no unrelated Tabby instances. Sum cumulative CPU deltas over samples inside each phase's UTC bounds; 100% means
one CPU core. Sum private bytes for committed process memory. Summed working sets also count shared pages in each
process and must not be called unique physical RAM. Preserve the raw JSON/JSONL, build identities and machine specs.

This comparison does not establish performance on Linux/macOS, H.264 workloads, physical GPUs or busy networks.
The PAM fixture separately covers TLS-only cached drawing orders; it does not reproduce an appliance's MFA or
session handoff.

## Windows comparison, 2026-11-16

Tabby 1.0.236 on Windows Server 2025 x64 (6 vCPU, 8 GiB) connected directly to Windows Server 2022 x64
(4 vCPU, 8 GiB) on the same hypervisor. Both clients used FreeRDP 3.33.1. Three alternating pairs ran for each
setting group: 20 seconds of motion, 12 input samples and five seconds idle per connection. All 48 checks passed.
The WebAssembly bridge uses direct Electron message ports and batches up to its 1 MiB ring-buffer limit.

| Settings | Runtime | Median frames/s | CPU, % of one core | Private memory, MiB | Input median / p95, ms |
|---|---|---:|---:|---:|---:|
| Compatibility options off | Native | 14.8 | 57 | 468 | 72.5 / 116 |
| Compatibility options off | WASM | 15.3 | 83 | 836 | 84.5 / 131 |
| Glyph + bitmap cache + relaxed checks | Native | 15.9 | 74 | 477 | 84.5 / 163 |
| Glyph + bitmap cache + relaxed checks | WASM | 15.1 | 108 | 860 | 94.5 / 159 |

CPU and memory are means of the motion phases across three runs, covering the whole Tabby process tree and any
native FreeRDP child. Latency percentiles pool 36 samples per row. Private bytes measure committed process memory,
not unique resident physical RAM. [Per-run measurements and binary identities](windows-x64.json) retain the input
samples and phase summaries. The source commit identifies the tested runtime; later documentation changes do not
change those binaries.

In this workload WASM had similar frame rates and input latency, with about 46% more CPU and 370–380 MiB more
private memory. This is a small synthetic VM comparison, not evidence that every desktop, GPU, network, codec or
long-running session performs similarly. Earlier small output batches accumulated cached-motion latency; the
measured build removes that bottleneck without unbounding the queue. Native builds remain available for repeatable
comparisons from source.
