# Selection redraw performance

A retained selection used to resolve every historical message's copy map on each
redraw. Decorators returning fresh frame arrays repeatedly triggered rectangle
verification and source-span projection, even for unchanged message bodies.

## Reuse and lazy composition

- Container reuses output only while width, children, input snapshots and its own
  tracked output remain valid. It still calls each child's render method.
- preserveSelection retains one exact paint/placement verification per immutable
  content snapshot. Changed text, metadata identity, styling, geometry or mutable
  output invalidates reuse. Lazy verification captures original painted strings.
- Vertical composition resolves requested rows through nested containers rather
  than eagerly expanding all child maps. Existing copy boundaries are retained;
  an unmarked span may require inspecting the leading boundary prefix.

No public API or selection/privacy check is removed. Undefined rows still use
legacy copying; empty rows remain decoration. Reading order and message identity
remain part of source-aware copying and stale-selection validation.

This is not constant work independent of transcript size: rendered arrays and
lazy row accessors still scale with line count. Individual component builders
and clipping retain their existing internal validation. A single enormous
message is not promised row-granular parsing. Decorator painting still runs;
its expensive unchanged verification is reused.

## Validation

The selection-lazy-cache regressions cover nested lazy work counts, mutable
aliases, source/width invalidation, frame reuse, styling/placement changes and
retained paint snapshots. The complete TUI tests, focused coding-agent copy,
decorator and hidden-thinking tests, root checks, offline build and isolated
repository test runner pass.

A controlled Node 22 comparison used the same message-frames 1.0.3 resource,
100x36 geometry, nested document/chat containers, synthetic Markdown history,
one changing tool Text and a retained two-row historical selection. Each case
ran in a separate process, with three warmups and 24 measured redraws. All
measured screen and selected-source hashes matched the installed baseline.

| History messages | Selection | Baseline mean/update | Candidate mean/update |
| ---: | :---: | ---: | ---: |
| 150 | no | 1.9 ms | 2.4 ms |
| 50 | yes | 28.3 ms | 1.3 ms |
| 150 | yes | 87.0 ms | 3.0 ms |
| 300 | yes | 159.8 ms | 6.4 ms |

At 150 selected messages, timer-callback p95 fell from 118.4 to 5.3 ms and peak
RSS from 203.4 to 119.8 MiB. The no-selection case has modest additional overhead.
These are controlled renderer measurements, not physical-terminal latency or a
claim that every user stall, or selection interruption during tools, is fixed.
