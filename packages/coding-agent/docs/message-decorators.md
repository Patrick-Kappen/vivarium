# Message decorators (Vivarium)

`pi.registerMessageDecorator(decorator)` wraps ordinary user and assistant
content in the interactive transcript. This is a Vivarium extension API; older
engines and stock Pi do not expose it. See [extensions](extensions.md) for
loading and [TUI](tui.md) for component rendering and interaction contracts.

Unlike `registerMessageRenderer` (custom messages) or
`registerMarkdownTransformer` (Markdown strings), this hook decorates existing
components. It never modifies session entries, model context, exports, print
output or RPC events. Concrete framing, labels and color choices belong in an
extension rather than engine defaults.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";

export default function extension(pi: ExtensionAPI) {
  pi.registerMessageDecorator((content, context) => {
    const box = new Box(1, 0, (text) => context.theme.bg("customMessageBg", text));
    box.addChild(content);
    return box;
  });
}
```

## Contract

The decorator receives a `Component` and `MessageDecorationContext`:

- `role`: `user` or `assistant`.
- `timestamp`: original message timestamp in Unix milliseconds; undefined for
  standalone components without a message timestamp. Do not substitute current
  time for unknown historical time.
- `isStreaming`: live assistant streaming state; false for users.
- `theme`: current theme, resolved lazily.

Read live context properties during `render()`, not only in the factory. A
streaming assistant may have no timestamp until its first `updateContent()`.
Factories are called when components are constructed (again on transcript
rebuild or user padding changes), not on every token. Do not allocate resources
requiring disposal or retain references to components outside the wrapper.

Register during extension initialization. Each extension has one decorator;
registering again replaces its registration for newly constructed components.
Decorators chain in extension load order, first innermost. Return `undefined`
or the original component to decline. Factory exceptions are reported through
the extension error channel and the previous content remains available.
Returned components are responsible for safe rendering, as with other TUI
extension components; exceptions thrown later by `render()` are not caught.

A wrapper must render the supplied content exactly once per render, forward
invalidation, and preserve mouse dispatch with translated coordinates when it
adds rows or columns. `Container` and `Box` already provide child dispatch.
Do not mutate the supplied component or its rendered line arrays. Use the
actual inner width, preserve terminal control sequences, and keep empty content
empty unless intentionally displaying a placeholder.

The engine's outer message component retains identity, settings updates,
thinking toggles and OSC 133 zones. Decorations are inside those zones. Tool
calls/results, custom extension messages, skill invocation blocks and summary
components are not decorated. Any separately displayed user text following a
skill invocation is decorated using that user message's original timestamp.

Removing an extension and reloading rebuilds the transcript without its
wrappers. No decoration is persisted. With no decorator, rendering follows the
existing component path unchanged.
