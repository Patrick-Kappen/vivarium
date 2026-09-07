# Interactive streaming status

The default working indicator describes the last observed engine activity, with
elapsed seconds in that phase. It is not a provider heartbeat or a claim that
remote computation is progressing.

- `Waiting for model`: a turn started, or a text/reasoning block ended and no
  subsequent activity has arrived. This includes time before response headers;
  the UI cannot distinguish provider computation, routing or transport waits.
- `Model reasoning` / `Model response`: reasoning/text stream events arrived.
- `Receiving tool call`: tool arguments are still arriving.
- `Tool call ready`: a complete tool call is available, but execution has not
  started. Receiving a tool call is not the same as running a tool.
- `Running tool` / `Running N tools`: execution-start events have arrived without
  matching execution-end events. Parallel completion does not mark other tools
  finished.
- `Tool finished`: the last active tool ended. The next turn changes this to
  `Waiting for model`; the completed tool card stays in the transcript.
- `Response finished`: the assistant message ended, before subsequent lifecycle
  events clear or replace the indicator. This is not a success assertion.

The clock measures phase duration, not time since the last token and not total
request duration. Repeated deltas in one phase do not reset it. Retry and
compaction indicators retain ownership of their existing status slot. Explicit
extension working messages still override the automatic message until reset;
hiding the working indicator stops its timer. There is no timeout, automatic
retry or provider-setting change in this feature.

A completed assistant's default collapsed reasoning label is `Thinking (hidden)`
rather than the live `Thinking...`. Custom labels and click-to-expand behavior
remain available. This is presentation only: hidden reasoning is not added to
copied text, model context or session data.

## Evidence and limits

A separate managed diagnostic session on 2026-09-07 used one harmless
`printf streaming-status-ok` tool call and a final short model reply. Metadata
tracing of the installed engine showed tool completion dispatched at 4091.196 ms
and the interactive handler finished at 4091.255 ms. At that point the pending
tool count was zero, but the visible generic working message was still active.
The next turn started at 4091.648 ms and the run ended at 4867.848 ms.

The first model fetch waited about 2.54 seconds for headers; the next waited
about 0.21 seconds. The user's long stall was not reproduced in this short run.
These measurements support fixing ambiguous status, not a claim that provider
latency or all streaming stalls are solved. Terminal writes are not pixel/display
acknowledgements. The opt-in trace logged fixed stages, event types, counts and
timestamps, not request/response bodies, tool arguments or credentials; the
active user session was not instrumented or changed.

`interactive-streaming-status.test.ts` exercises real interactive event handlers
with controlled clocks, including long silence before output and after tool
completion, parallel tools, stream boundaries, extension overrides, visibility,
compaction precedence and timer cleanup. Existing thinking-click and message-copy
regressions retain their assertions with the intentionally changed completed
label.
