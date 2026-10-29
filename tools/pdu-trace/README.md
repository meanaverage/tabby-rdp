# PDU trace viewer

A page that shows the exact flow of RDP PDUs of one tabby-rdp connection: the connection sequence, every graphics
command, the client's acknowledgements, what the browser's H.264 decoder did with each access unit and when the
canvas was resized and drawn, with each resize of the remote display laid out step by step and checked.

## Getting a trace

Turn on **Settings › Remote Desktop › Settings › Diagnostics › Write a log file** (Debug is enough). Each desktop
opened from then on writes, next to its diagnostic log file in the log folder, a trace named like the log with
`.otlp.json` in place of `.log`: an OpenTelemetry trace (OTLP/JSON, `resourceSpans`) that any OTLP tool can read as
well. The file is written when the connection ends, when the desktop closes, and every two minutes meanwhile.

The trace is taken at the plugin's RDCleanPath proxy, where the stream is in the clear between the proxy and IronRDP
(TLS is the proxy's, toward the server), so it holds what was really on the wire, timed as it passed: X.224, MCS, the
share control and data PDUs, fast-path updates and input, the static channels and the dynamic channels inside
drdynvc, the graphics pipeline (ZGFX-decompressed) and display control among them. It records structure and sizes,
never content that could be a secret: CredSSP tokens, licensing material, keystrokes and clipboard data appear by kind
and length only; bitmaps and H.264 are described (codec, rectangle, bytes, key frame, coded picture size), not kept.
Names (yours, the desktop's, its address) are in it, as in the log: look through a trace before you attach it to a
report.

A diagnostic log written before the trace existed can be turned into a coarser trace with
`node tools/pdu-trace/from-log.mjs <log>` (after `npm run build`): the resize requests, resets and surfaces are in a
debug log; frames, acknowledgements and the decoder's timing are not.

## FreeRDP, for comparison

The FreeRDP helper's traffic doesn't pass the proxy (TLS is its own), so it can't be tapped; FreeRDP logs each
graphics command it receives instead. Start Tabby, or the suite, with FreeRDP's logging aimed at a file (the plugin
hands these through to the helper) and `TRD_FREERDP_PIPELINE=1` so that a Windows desktop uses the graphics pipeline
as IronRDP does (the plugin keeps FreeRDP on bitmaps there otherwise):

```sh
export WLOG_APPENDER=FILE WLOG_FILEAPPENDER_OUTPUT_FILE_PATH=/tmp/rdp WLOG_FILEAPPENDER_OUTPUT_FILE_NAME=freerdp.log
export WLOG_FILTER='com.freerdp.channels.rdpgfx.client:TRACE,com.freerdp.channels.disp.client:DEBUG' TRD_FREERDP_PIPELINE=1
node tools/pdu-trace/from-freerdp-log.mjs /tmp/rdp/freerdp.log <the plugin's .otlp.json of the same connection>
```

The result is a trace in the same form (the resize requests and the canvas from the plugin's trace, the commands
and acknowledgements from FreeRDP's log), which the viewer and the suite's checks take as they take IronRDP's. The
suite does this itself with `TRD_TEST_CLIENT=freerdp`.

## Reading it

Open `tools/pdu-trace/index.html` in a browser (it loads D3 from cdnjs) and drop the `.otlp.json` on it.

- **Whole connection**: bytes each way over time, resizes as shaded bands, errors as red dots. Drag to pick the
  window the other instruments show.
- **PDU lanes**: one mark per PDU, by where it came from and what it is; bars for spans (a graphics frame from Start
  Frame to the client's Frame Acknowledge; an H.264 access unit from hand-out to pixels; a legacy frame between its
  markers). Wheel to zoom, drag to pan, click a mark for every decoded field and the other PDUs of the same frame.
- **Resize ledger**: one resize at a time: the monitor layout sent, and what followed, with the time since the
  request; and the checks a clean resize keeps: the server reset the graphics to the requested size (or
  deactivated and reactivated at it); a surface of that size was created and mapped; the first frame at the new size
  was acknowledged, is a key frame when it is H.264, has a coded picture the surface's size, and covers the surface;
  no surface command reaches past the new edge; the canvas was resized before the first draw at the new size; H.264
  decoded without errors or long waits; and how long the whole thing took.
- **Pacing**: acknowledgement latency per frame and decoder latency per access unit, in the lanes' window.
- **All PDUs**: the flat list with a filter (a name, or `field=value`); a click shows the PDU in the lanes.

## Spans

| Span | From | To |
|---|---|---|
| `rdp.connection` | the first byte | the trace's end |
| `rdp.activation`, `rdp.reactivation` | Demand Active | Font Map |
| `rdp.resize` | the Display Control monitor layout the client sent | the client's Frame Acknowledge of the first frame on a surface of the requested size (or the first update after a reactivation at it); an error status when another request came first, or nothing matched within ten seconds |
| `egfx.frame` | Start Frame | Frame Acknowledge (End Frame is an event on it) |
| `fastpath.frame` | Frame Marker begin | Frame Marker end |
| `h264.decode` | the access unit handed to the browser's decoder | its pixels (or a skip, or an error) |

Every PDU is an event on the innermost span it falls in, with `dir` (`in` from the server, `out` from the client,
`local` for this side), `layer`, `bytes` and the decoded fields. Runs of auto-detect PDUs (a Windows server measures
bandwidth hundreds of times a second) fold into one event per kind with `repeat` and `untilUnixNano`.

## Tests

`npm run test:unit` covers the decoder, the ZGFX decompressor (against IronRDP's vectors) and the spans
(`test/unit/pdu-trace.ts`, `test/unit/zgfx.ts`). `npm test -- pdu-trace` connects a real desktop (`TRD_TEST_RDS` or
`TRD_TEST_DIRECT`), resizes it larger twice, and checks the flow and the picture against the trace
(`test/suites/pdu-trace.ts`).
