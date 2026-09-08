# Retained viewport rendering

Scrolling previously rebuilt the layout and called every historical component's
renderer, even when only the scroll offset changed. Component-local caches still
left history traversal, frame decoration and output validation on that path.

TuiAltScreen now distinguishes internal viewport requests from content requests.
A viewport-only request reuses the last layout's immutable rendered strings and
selection maps. It copies and repositions layout boxes, recalculates clipping,
and paints the visible terminal rows without calling the content renderers.
Scrollbar hover/fade, scroll navigation and selection autoscroll use this path.
Search also recognizes retained immutable history without comparing every line.

## Invalidation and ownership

- Public `requestRender()`, explicit `renderNow()`, keyboard content rendering,
  invalidation and render-state reset require a fresh layout.
- A queued content request wins over a viewport request in either order.
- Changed terminal dimensions or scrollbar content width reject retained layout.
- Content requests raised during rendering remain pending for the next frame.
- Repainting copies geometry rather than mutating the previous selection frame.
  Rendered strings and selection-map identity remain tied to the same snapshot.
- Mutable component output cannot alter an already captured snapshot. Callers
  still need to request rendering when they change content or theme state.

All history remains available for backscrolling, full-history search and copying.
There is no last-N-messages cutoff and no background timer that drops history.

## Scope

This is retained-layout reuse, not lazy initial rendering or a three-screen
render budget. Initial rendering, streaming/content requests, theme invalidation
and resizing still lay out the full document. The cache retains the current full
rendered history, not multiple generations or width variants. It has no new LRU
memory limit. Layout-box traversal and visible-row ANSI composition still run;
this is not a claim that every operation is independent of history size.

True viewport-plus-buffer rendering also needs a height/loading contract: the
current Component interface only reveals wrapped height by rendering. Avoiding
that initial work while preserving exact scroll geometry is a separate change.

## Validation

Run from `packages/tui`:

```sh
node --test test/retained-viewport.test.ts test/layout.test.ts test/tui-alt-screen.test.ts
```

The dedicated regressions cover render-call counts, immutable snapshots, nested
and side-by-side panes, scrollbar-width invalidation, image clipping, scheduled
wheel/page scrolling, streaming follow-end, content/scroll races, resize, root
replacement, keyboard and mouse content updates, search and retained copying.

A controlled Node 22.23.2 comparison against base `ec8b96328` used the same built
message-frames 1.0.4 resource on both engines: a 100x36 terminal, 20 ANSI-styled
body lines per message, 15 warmup wheel events and 60 measured wheel events.
Measurements sum input-handler and scheduled-render CPU time; they exclude the
scheduler wait and physical terminal. Explicit `renderNow()` must not be used to
measure this fast path because it intentionally requests a fresh content layout.

| Messages | Retained selection | Base mean | Retained mean | Retained p95 |
| ---: | :---: | ---: | ---: | ---: |
| 150 | no | 6.91 ms | 5.25 ms | 5.92 ms |
| 150 | yes | 7.96 ms | 5.58 ms | 6.52 ms |
| 600 | no | 12.03 ms | 5.12 ms | 5.75 ms |
| 600 | yes | 17.90 ms | 5.49 ms | 6.47 ms |

Terminal-output SHA-256 hashes and byte counts match for every base/candidate
pair; selected text copied after scrolling also matches. These are synthetic
renderer measurements, not physical-terminal latency or a streaming speedup.
