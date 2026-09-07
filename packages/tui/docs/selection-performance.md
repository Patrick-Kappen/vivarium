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

## On-demand source preparation

Text no longer strips terminal sequences or allocates a copy source in its
constructor or setText. Its exact rendered snapshot resolves the source on the
first metadata request. Markdown similarly defers its emitted text sources,
normalization checks, code highlighter validation and code-line descriptors.
Visible rendering is unchanged; selection never replays a renderer, highlighter,
transformer or theme callback. There is no automatic end-of-round calculation.

A bounded cache cell per emission slot reuses equal logical sources even when
snapshots resolve out of order. Each render memoizes its own result, so a later
update cannot replace an old snapshot's source. Cache cells do not retain old
render recipes: thousands of unselected updates cannot form a recursive chain.
Rewriting highlighters and backgrounds retain their conservative fallback.

Wrapping ranges, token provenance and rendered strings still must be recorded
while painting. In particular, original tab/newline lexer tracing remains in
the render path. This is not a claim of zero selection bookkeeping, nor does it
change the existing granularity inside one large component. Selection may need
to validate a whole code block before trusting its source.

Eleven additional demand regressions verify unresolved source caches, both
resolution orders, old-source ownership, 10,000 unselected updates, normalization
and fail-closed rewriting. The full TUI suite (1,330 passes, two skips, six TODOs),
45 focused coding-agent tests, root check, offline build and isolated repository
test runner pass.

A separate sequential Node 22 probe compares the already-fixed installed engine
with this follow-up: 100-column Text/Markdown components, synthetic growing
content, three warmups and 24 updates, with no selection during streaming. Mean
setText-plus-render times were:

| Fixture | Installed | On-demand preparation |
| --- | ---: | ---: |
| 800 code lines | 1.79 ms | 1.38 ms |
| 600 prose paragraphs | 5.61 ms | 5.46 ms |
| 600 code lines with tabs/CRLF | 1.83 ms | 1.37 ms |
| 800 ANSI-styled Text lines | 2.39 ms | 1.25 ms |

All frame and final full-copy hashes match. This shifts work rather than deleting
it: final full-code-copy time was 55.54 -> 60.33 ms and full Text copy was
38.82 -> 44.25 ms. These deliberately large full-copy operations are not a
mouse-to-highlight benchmark. Prose timer p95/RSS did not improve in this run;
no universal latency or memory improvement is claimed.
