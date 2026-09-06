# Source-aware fullscreen selection (proposal)

Status: draft internal Text and layout/fullscreen integration. Text, Box, VStack
and HStack forward source metadata. Basic Markdown emission is now mapped, but
table coverage, lexer provenance and extension integration remain unfinished.
No public selection API is exported.
Baseline: Vivarium `d0e76d057` (merged Pi 0.85.1 synchronization).

## Implementation progress

`wrapTextWithAnsiRanges()` now records each emitted row's input start/end offsets
while wrapping. It shares the existing wrapping implementation; the ordinary
string-array facade does not allocate range arrays. Offsets exclude synthetic
style carry/reset sequences and point into the unchanged input, so gaps retain
omitted wrap whitespace and real newline sequences without reconstruction.

Text now binds a lazy cell/source map to each exact rendered string-array snapshot.
Wrapping offsets are recorded during rendering; cell maps are built only when
queried, from that snapshot's original text, not current mutable component state.
Expanded tab cells map to the original tab. Text padding has empty metadata;
real blank lines have zero-cell source anchors. Reaching the final visible content
boundary includes source trailing whitespace removed by wrapping, even when no
cells remain for it. Selecting padding beyond that anchor does not select text.

Plain Container forwards child snapshots without requiring a second render method
that could accidentally bypass a subclass's overridden render(). ScrollView copying
uses the existing unscrolled content snapshot. The non-scroll viewport projects
leaf metadata through vertical and horizontal clipping. Both clipboard extraction
and highlighting use mapped spans.
Box translates child spans past its padding. VStack omits gap/growth rows and
clips child maps to allocated heights; viewport projection does the same for
full-width vertical layout nodes. ScrollView's string-array facade also forwards
maps when reserving a scrollbar column.

HStack gives each horizontal occurrence a stable lane, including repeated uses of
one cached Text. Selection follows screen row order: separate lanes on the same
row receive a tab, and changing copy blocks across rows receives a newline.
Uninterrupted text in one lane still copies its original logical wraps/newlines.
For example, two wrapped columns copy `alpha\tgamma\nbeta\tdelta`, not two
reordered complete paragraphs. Alignment padding, hidden/zero-width children and
gaps contribute no text. Trailing whitespace anchors belong to their preceding
content, not the first cell of the next pane.

Clipping removes whole source graphemes and marks interrupted runs per source/lane.
Expanded tab cells are explicitly splittable: a visible part still copies one
original tab and highlights only the visible cells.
It must not bridge a hidden suffix or an entirely clipped row when joining later
visible spans. Partially visible ScrollViews also restrict their copy source to
the allocated horizontal clip. The renderer now respects parent horizontal clips
when nested minimum sizes exceed their allocation, instead of painting into an
adjacent column's gap. Over-wide leaf output is clipped before selection styling,
so final truncation cannot discard the selection's closing ANSI reset.

An unmapped child inside these wrappers remains a set of independent legacy copy
rows: visual wraps stay newlines and selected trailing whitespace is still trimmed.
Only the enclosing wrapper's known padding is excluded. Legacy frame characters
are not stripped. Background functions that rewrite content trigger fallback.
Legacy rows in mixed selections retain their existing content semantics. Independent copy
blocks currently receive one separating newline in addition to their source text,
except for the same-row horizontal tab rule. The general boundary/occlusion contract
is still pending. In particular, viewport maps exclude painted scrollbar cells,
while scroll-owned selections retain the logical content width beneath an automatic
overlay scrollbar. Transient overlay policy is not claimed complete by this step.

Box caching separates painted output from source snapshots. Equal-looking tabs
and spaces can reuse painting but require distinct metadata snapshots. Unchanged
child snapshots still reuse the cached result. Text source identity is tied to
logical text rather than measurement width, so incidental mouse/layout renders
and styling invalidation cannot cancel an otherwise unchanged selection.
Layout and horizontal-facade snapshots also own their painted arrays, retaining
the original metadata factory even if a legacy renderer later mutates its array.
Sparse legacy arrays are copied by existing indices rather than expanding holes;
a billion-row sparse regression protects the clipped-viewport rendering path.

Selections are cleared on width changes, changes to selected source mappings,
removal of the selected scroll view or appearance/disappearance of an overlay.
Scrolling and unrelated appends preserve unchanged selected blocks. Mutated legacy
render arrays, text-rewriting background callbacks and glyphs too wide for the
viewport fall back rather than receiving guessed mappings. This is an internal
prototype fallback, not the final validation policy for a public metadata API.

`../test/text-selection.test.ts` contains 28 Text and 20 vertical-composition tests.
`../test/horizontal-selection.test.ts` adds 38 horizontal, clipping and snapshot
regressions. Both use the shared fullscreen SGR selection fixture.
The earlier Text, Box and standalone Markdown code-indent cases now assert corrected
output; unmanaged decorator losses remain explicit characterization tests. No real editor paste or
terminal-native selection guarantee is claimed yet.

Tests in `../test/wrap-source-ranges.test.ts` cover exact source offsets, explicit
newlines/blank lines, omitted wrap spaces, styling, tabs before expansion and
wide/combining/emoji graphemes. Existing wrapping tests remain the independent
render-output regression check.

### Markdown coverage

`MarkdownSelection` records logical visible text at emission sites, before wrapping
and margins. Paragraphs, inline formatting/links, headings, code blocks, lists and
display math now have source maps, including supported content inside recursively
nested quotes and lists. Heading prefixes, code fences, code presentation indent
and horizontal rules are explicitly decoration, not stripped heuristically
at copy time. Literal identical characters inside code remain content.

Code spans reference one token-text source across its real lines and soft wraps,
including blank/space-only lines and trailing spaces. Styling-only highlighters
inherit that source only after exact visible-text validation. Rewriting or
reordering highlighters retain legacy body rows rather than copying hidden original
code. Transformers still run before parsing at the original content width, and
copy uses their visible output. Link URLs hidden in OSC 8 are not copied.

Quote wrappers forward child metadata before adding their declared decorative
prefixes. Further wrapping projects the existing spans rather than inventing a
new source from border-prefixed output. The renderer still trims the same trailing
empty quote rows and invokes quote styling/border callbacks in the same order.
Inherited block metadata is resolved once per wrapped snapshot, not rescanned for
every row; a read-count regression guards against quadratic validation work.

List markers, displayed numbering, task state and canonical nesting indentation
are content; continuation prefixes are decoration. A semantic marker joins its
first body's source and lane, starting at the first mapped source offset rather
than restoring hidden leading data. Compositions use a bounded weak source cache.
Loose-list separation remains explicit content. Further wrapping retains mapped
whitespace omitted at recorded wrap boundaries, including nesting indentation in
very narrow quotes; it does not turn unmarked continuation padding into content.

Display math copies its rendered Unicode rows and intrinsic alignment, without
hidden LaTeX delimiters. Delimiters remain content when disabled or unsupported
math rendering leaves them visibly printed. Formula layout is not outer padding.

Unchanged logical sources survive incidental measurement renders and unrelated
paragraph or list-item appends. A streamed partial closing fence remains excluded when the
closing fence completes. Old rendered snapshots do not read later Markdown state.
Zero-cell blank anchors outside a clipped pane cannot select the neighbouring pane.

This is deliberately incomplete: tables and unknown token output retain legacy
content rows. Enclosing mapped lists and quotes exclude their own presentation
without claiming those bodies are source-aware. Inputs containing tabs or CR
currently keep the whole Markdown component unmapped because preprocessing and
lexer normalization do not yet carry their original offsets. LF code token text
is supported; this is not an original-Markdown-byte preservation guarantee.
Multiple source blank lines collapsed by the renderer are not reconstructed.
The existing general separator/occlusion and public API limitations still apply.

`../test/markdown-selection.test.ts` contains 62 focused regressions. Existing Markdown
render tests remain the independent check that presentation is unchanged. All of
the remaining cases must be addressed before claiming complete message copying.

## Scope and ownership

This work is an engine correctness fix, not a theme extension. Responsibilities
are split as follows:

| Owner | Owns | Does not own |
| --- | --- | --- |
| Vivarium engine | Logical selection, copy extraction, wrapping metadata and the generic rendering/decorator contract | Role/time styling, frame design or a resource-specific color palette |
| `message-frames` in vivarium-resources | User/assistant message layout, role/time presentation, spacing, borders or borderless panels, and selection of existing theme color tokens | Clipboard reconstruction, copy-action interception, global theme colors, message content or toolcall rendering |
| Theme resource in vivarium-resources | Color values for existing semantic theme roles | Message layout, selection or clipboard behavior |
| Warden | Engine packaging and engine revision; resource packaging constructors | Resource styling or consumer activation |
| Consumer (`nixos-config`) | Warden/resource pins, selected extensions/theme and their configuration | An independent engine revision overriding Warden |

The engine must not depend on message-frames to provide correct mapped selection.
The extension will only describe its own decoration and forward child metadata
through the generic API once implemented. Disabling the extension restores
ordinary presentation without disabling engine fixes. Components without metadata
retain the explicitly scoped legacy fallback described below.

Two separate workstreams and PRs:

1. Engine selection correctness and its generic API, with engine-owned tests.
2. Message-frames presentation, with resource-owned tests and a resource version.
   Its later adoption of the selection API is an explicit compatibility change;
   keep that integration distinguishable from the borderless layout redesign.

A new color palette and a second extension styling the same messages are outside
this scope. Toolcalls, streaming lifecycle, message/session data and model context
remain unchanged. Release order is engine API, resource integration, then explicit
consumer activation through a compatible Warden pin; no resource updates an
engine or activates itself implicitly.

## Problem and measured baseline

On the original baseline, `TuiAltScreen.getActiveSelectionText()` sliced rendered
terminal rows, stripped terminal sequences, trimmed each row's end and joined
rows with `\n`. That remains the fallback for unmapped content. Clipboard transport
improvements alone do not change this input.

For example, a single logical line renders at width 32 as:

```text
alpha beta gamma delta epsilon
zeta eta theta iota kappa lambda
```

On the original baseline, both fullscreen selection paths copied this visual newline.
A frame also inserts borders into multiline selection, even when both mouse
endpoints are inside the body. Removing borders alone does not solve wrapping.

`../test/selection-copy-baseline.test.ts` drives SGR press/drag/release through
`TuiAltScreen` and captures its injected clipboard callback. Thirteen baseline
cases cover explicit and blank lines, indentation, wrapping, generic decoration,
Box padding, tabs, trailing spaces, Markdown code and prose, graphemes, resizing
before selection and scrolled content coordinates. Text and Box cases now assert desired
behavior; remaining losses characterize unmapped components. Six TODO targets
track the broader cross-renderer integration, not missing Text-only tests.
No system clipboard or model endpoint is used by these tests.

## Required behavior

- Copy logical visible content, not terminal presentation or raw message JSON.
- Preserve literal content characters, code indentation, tabs, trailing spaces,
  explicit newlines and blank lines. Identical characters used as decoration
  must not be copied. Never strip borders or infer indentation from whitespace.
- Soft wrapping inserts no source newline and must retain wrap whitespace that
  the renderer omits at a visual boundary. Partial selections include only the
  logical interval between their selected content endpoints.
- Markdown prose copies its displayed semantics (`**bold**` becomes `bold`),
  not hidden markup. Code copies its logical code text without renderer-added
  indentation or fence labels. A full-message Markdown-copy command is separate.
- Markdown transformations run as today. Selection describes their displayed
  result, not pre-transform content. Collapsed thinking and other hidden content
  must never enter a selection through a source interval.
- Preserve existing component identities, thinking mouse dispatch, OSC133 zones,
  streaming, session data, model context, custom messages and toolcalls.
- Retain legacy selection for components without metadata, as requested. Such
  components do NOT gain logical-text guarantees automatically.
- Native terminal/Shift selection remains terminal-owned. This contract applies
  to application-owned fullscreen selection, not terminal-native copying.

## Proposed rendering contract

The initial proposal considered `Component.renderWithMetadata(width)`. The Text
prototype instead keeps `render(width): string[]` unchanged and uses an internal
WeakMap keyed by the exact returned array. This avoids inherited metadata methods
bypassing an overridden render() in legacy wrappers. A changed array is not a
valid mapped snapshot. Container forwards metadata for its own concatenation;
Box, VStack, HStack and the ScrollView facade forward their explicit geometry.
Extension wrappers still need equivalent integration through a validated public API.

The public helper/API shape remains under review until composition is complete.
The types below describe the intended information, not the current internal
storage format. Rendering must remain single-pass and snapshot-coherent.

Illustrative types, not an exported API yet:

```ts
interface CopyDocument {
  readonly id: object;           // Stable identity of one logical copy block
  readonly revision: number;     // Changes when its copy text changes
  readonly text: string;         // Logical visible text, no ANSI or decoration
}

interface CopySpan {
  readonly columnStart: number;  // Inclusive terminal cell column
  readonly columnEnd: number;    // Exclusive terminal cell column
  readonly document: CopyDocument;
  readonly sourceStart: number;  // Inclusive UTF-16 offset in document.text
  readonly sourceEnd: number;    // Exclusive UTF-16 offset in document.text
}

interface SelectionRow {
  readonly spans: readonly CopySpan[];
}

interface SelectionMap {
  readonly rows: readonly SelectionRow[];
}

interface RenderResult {
  readonly lines: string[];
  readonly selection?: SelectionMap;
}
```

A render result is an immutable snapshot by contract. Maps have exactly one row
per rendered line. Spans are ordered, non-overlapping and within rendered cell
bounds. Source offsets fall on grapheme boundaries, not arbitrary code units.
A wide character or displayed tab expansion may occupy several cells but maps
to its entire source grapheme. Begin with grapheme-level spans for correctness;
compress ordinary runs only after measuring memory and streaming costs.

An absent map means legacy behavior. A present map with empty spans means known
non-content, not fallback. Thus headers, borders, layout padding, scrollbars and
image protocol data can be deliberately excluded without string heuristics.
Invalid provided metadata must be diagnosed and excluded from mapped copying;
do not silently expose supposedly decorative text via legacy fallback.

Each document contains one continuous logical copy block, in reading order.
It is NOT the original message source: hidden/collapsed content and unrendered
Markdown syntax are absent. Renderers must split documents if displayed ranges
are discontinuous or reordered. Do not bridge arbitrary gaps in raw Markdown.

Within a document, real newlines and wrap whitespace live in `text`. For a
selection spanning multiple visual rows, extract the interval between mapped
endpoints once, rather than joining row strings. A selected empty content line
needs an explicit zero-width span at its source boundary; it must not look like
an empty decorative row. Empty rows between selected endpoints are preserved
through the logical source interval.

Independent documents need an explicit composition boundary, not a heuristic
based on their visual spacing. Proposed defaults: one newline between vertically
stacked copy blocks; no newline for wrapper decoration. The implementation must
extend the prototype's vertical child-boundary markers into a complete separator
contract before supporting arbitrary mixed layouts. Horizontal stacks and Markdown tables need an explicit reading order
and separator policy (for example a tab between cells), or legacy fallback for
that entire region until specified. The illustrative types above intentionally
do not claim to settle these composition boundaries.

## Propagation through the engine

1. Add an internal wrapping primitive that returns lines AND their source spans.
   Keep `wrapTextWithAnsi()` as the existing string-array facade. Do not recover
   mapping by comparing rendered text with source strings after rendering.
2. Make Text construct its copy document before tab expansion and attach spans
   during wrapping. Added margins/background fill have no spans. Its existing
   whitespace-only rendering behavior stays unchanged unless separately agreed.
3. Make Markdown construct logical visible copy text during token rendering,
   retaining token-to-cell mapping through final wrapping. Preserve the existing
   transform and highlighting pipelines. A highlighter/transformer that changes
   text requires explicit mapping or scoped fallback, never guessed offsets.
4. Make Container, Box and stacks compose child snapshots and translate spans
   along with lines. Existing wrappers that call `child.render()` directly must
   adopt the shared helper to forward maps. Opting in only Text is insufficient.
5. Cache RenderResult atomically in layout measurement/painting. Carry maps into
   LayoutBox and LayoutFrame, including unscrolled ScrollView content. Apply the
   same clipping, line offsets, translations and overlay occlusion as painting.
   A painted decoration must not reveal selectable text behind it.
6. Let user/assistant inner wrappers and decorators forward child results using
   generic helpers for padding, translation and decorative rows. Preserve their
   outer component identity and current mouse-coordinate translation. No role,
   timestamp or `message-frames` special cases belong in the clipboard engine.
7. Resolve selection endpoints and highlights from the same snapshot. Extract
   logical intervals for mapped blocks and legacy row slices only for unmapped
   blocks. Pass the result to the existing injected clipboard/native transport.

For mixed mapped/unmapped content, represent legacy blocks explicitly when
composing results. Do not drop an unmapped toolcall and do not downgrade a whole
transcript (which would make message decoration selectable again). Keep the
legacy trimming/wrapping behavior localized to that legacy block. Do not change
toolcall rendering or its streaming lifecycle as part of this work.

## Selection lifecycle

Screen columns and source offsets are different coordinate systems. Selection
anchors should include document identity, revision and source boundaries. Keep
content-relative coordinates for ScrollView hit testing; pure scrolling must
not change selected source text or copy offscreen content outside the interval.

Initial safe policy: clear a selection if a selected document changes or a
reflow invalidates its mapping. Do not reinterpret old screen coordinates against
new text. Unrelated message appends and scrolling should retain selections of
unchanged documents. Source-anchored selection surviving arbitrary reflow is an
optional later enhancement, not a reason to copy the wrong text in version one.
Text acceptance coverage now exercises changed selected content, unrelated streaming
appends, scroll drags, removed scroll views and resize. Message/Markdown integration
still needs equivalent coverage.

Drag, reverse drag, word/line selection, keyboard copy and selection highlighting
must use the same boundary resolution. A decoration-only selection yields no
clipboard write. Endpoints in decorative cells snap inward to selected content;
partial wide/tab cells select a complete mapped grapheme. Document boundaries
must also handle explicit trailing newlines without duplicating separators.

## Implementation and validation sequence

1. Turn baseline cases into desired-output regressions alongside a pure mapping
   extractor and source-aware Text wrapping. Include partial/reversed selection,
   wrap spaces, tabs, wide/combining/emoji glyphs and literal border characters.
2. Add atomic render/map composition and both fullscreen selection paths. Cover
   nested Container/Box/stacks/ScrollView, clipping, overlays, gaps, scrollbars,
   mixed legacy content, offscreen selection, invalidation and cache coherence.
3. Add Markdown mapping and coding-agent integration tests: paragraphs, lists,
   links, code blocks, tables, transforms, highlighting, collapsed thinking,
   streaming, historical messages and unchanged OSC133/component identities.
4. Publish the minimal reviewed types/helpers and document the extension
   contract. Connect message-frames in a separate resource change. Keep the
   borderless layout prototype separate; disabling decoration must still work.
5. Run focused TUI and coding-agent tests plus `npm run check`; measure render
   cost and map memory on large/streaming transcripts. Finish with actual paste
   into an editor. Test native terminal selection separately and report limits.

No acceptance claim should be based solely on the green characterization suite.
The TODO targets become executable passing tests as the corresponding behavior
is implemented. This Text integration is submitted on the same draft engine PR,
not as a completed message/Markdown clipboard fix. Validation passes with `npm run check`
and the full isolated `./test.sh` after `npm run build:offline`. No resource,
consumer pin update or deployment is included.
