import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { getSelectionMap } from "../src/selection-map.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class SelectionTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

interface Fixture {
	tui: TuiAltScreen;
	terminal: SelectionTerminal;
	scroll: ScrollView;
	copied: string[];
}

async function withSelection(
	component: Component,
	width: number,
	mode: "implicit" | "scroll" | "viewport",
	run: (fixture: Fixture) => Promise<void>,
	height = 64,
): Promise<void> {
	const terminal = new SelectionTerminal(width, height);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const scroll = new ScrollView(component, { primary: true });
	if (mode === "implicit") tui.addChild(component);
	else tui.setLayoutRoot(mode === "scroll" ? scroll : component);
	try {
		tui.start();
		tui.renderNow();
		await terminal.flush();
		await run({ tui, terminal, scroll, copied });
	} finally {
		tui.stop();
	}
}

function select(fixture: Fixture, startX: number, startY: number, endX: number, endY: number): void {
	fixture.terminal.sendInput(`\x1b[<0;${startX + 1};${startY + 1}M`);
	fixture.terminal.sendInput(`\x1b[<32;${endX + 1};${endY + 1}M`);
	fixture.terminal.sendInput(`\x1b[<0;${endX + 1};${endY + 1}m`);
	fixture.tui.renderNow();
}

describe("source-aware Text fullscreen selection", () => {
	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`preserves full logical text at multiple widths, excluding Text padding (${mode})`, async () => {
			const source = "  first\tvalue  \n\n\tsecond line\nend  ";
			for (const width of [6, 12, 32, 80]) {
				const component = new Text(source, 2, 1);
				const lastRow = component.render(width).length - 1;
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, lastRow);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [source], `width=${width}`);
				});
			}
		});

		it(`preserves partial intervals across a soft wrap, including reverse drag (${mode})`, async () => {
			for (const reverse of [false, true]) {
				await withSelection(new Text("alpha   beta gamma", 1, 0), 10, mode, async (fixture) => {
					if (reverse) select(fixture, 2, 1, 3, 0);
					else select(fixture, 3, 0, 2, 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, ["pha   be"]);
				});
			}
		});

		it(`does not copy or highlight padding-only selections (${mode})`, async () => {
			await withSelection(new Text("content", 2, 1), 20, mode, async (fixture) => {
				fixture.terminal.writes.length = 0;
				select(fixture, 0, 1, 1, 1);
				assert.equal(fixture.tui.hasActiveSelection(), false);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
				assert.deepEqual(fixture.copied, []);
				assert.ok(!fixture.terminal.writes.join("").includes("\x1b[7m"));
			});
		});
	}

	it("copies and highlights an entire source tab when selecting inside its expanded cells", async () => {
		await withSelection(new Text("\tvalue", 0, 0), 20, "scroll", async (fixture) => {
			fixture.terminal.writes.length = 0;
			select(fixture, 1, 0, 2, 0);
			assert.ok(fixture.terminal.writes.join("").includes("\x1b[7m   \x1b[27m"));
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["\t"]);
		});
	});

	it("preserves source tails removed by the renderer at the right edge", async () => {
		const source = "abcdefgh   \nnext\t  ";
		const component = new Text(source, 0, 0);
		await withSelection(component, 4, "scroll", async (fixture) => {
			select(fixture, 0, 0, 3, component.render(4).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, [source]);
		});
	});

	it("preserves explicit CRLF, CR, blank lines and a final newline", async () => {
		const source = "one\r\n\r\ntwo\rthree\nfour\n";
		const component = new Text(source, 0, 0);
		await withSelection(component, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 19, component.render(20).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, [source]);
		});
	});

	it("retains literal border characters while removing styling and layout padding", async () => {
		const component = new Text("\x1b[31m|content|\n  |more|\x1b[0m", 2, 1, (text) => `\x1b[44m${text}\x1b[49m`);
		await withSelection(component, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 19, 3);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["|content|\n  |more|"]);
		});
	});

	it("keeps legacy behavior local to unmapped components", async () => {
		const container = new Container();
		container.addChild(new Text("alpha beta gamma delta", 0, 0));
		container.addChild({ render: () => ["LEGACY  ", "  line  "], invalidate: () => {} });
		container.addChild(new Text("last", 0, 0));
		await withSelection(container, 12, "scroll", async (fixture) => {
			select(fixture, 0, 0, 11, container.render(12).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["alpha beta gamma delta\nLEGACY\n  line\nlast"]);
		});
	});

	it("keeps wide, combining and emoji graphemes whole", async () => {
		const source = "A\u754cB\ne\u0301\ud83d\udc69\u200d\ud83d\udcbbZ";
		await withSelection(new Text(source, 0, 0), 20, "scroll", async (fixture) => {
			select(fixture, 2, 0, 2, 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["\u754cB\ne\u0301\ud83d\udc69\u200d\ud83d\udcbb"]);
		});
	});

	it("clears an active selection on reflow rather than applying stale cell coordinates", async () => {
		await withSelection(new Text("alpha beta gamma delta", 0, 0), 12, "scroll", async (fixture) => {
			select(fixture, 0, 0, 5, 1);
			assert.equal(fixture.tui.hasActiveSelection(), true);
			fixture.terminal.resize(30, 64);
			fixture.tui.renderNow();
			assert.equal(fixture.tui.hasActiveSelection(), false);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
		});
	});

	it("clears selection when selected content changes, but not on unrelated appends", async () => {
		const selected = new Text("stable text", 0, 0);
		const streaming = new Text("partial", 0, 0);
		const container = new Container();
		container.addChild(selected);
		container.addChild(streaming);
		await withSelection(container, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 5, 0);
			streaming.setText("partial response growing\nmore");
			fixture.tui.renderNow();
			assert.equal(fixture.tui.hasActiveSelection(), true);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["stable"]);
			selected.setText("different text");
			fixture.tui.renderNow();
			assert.equal(fixture.tui.hasActiveSelection(), false);
		});
	});

	it("extends a drag through scrolled content without reinterpreting its anchor", async () => {
		const source = Array.from({ length: 20 }, (_, row) => `line ${row}`).join("\n");
		await withSelection(
			new Text(source, 0, 0),
			20,
			"scroll",
			async (fixture) => {
				fixture.terminal.sendInput("\x1b[<0;1;2M");
				fixture.scroll.scrollTo(3);
				fixture.tui.renderNow();
				fixture.terminal.sendInput("\x1b[<32;6;4M");
				fixture.terminal.sendInput("\x1b[<0;6;4m");
				fixture.tui.renderNow();
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["line 1\nline 2\nline 3\nline 4\nline 5\nline 6"]);
			},
			6,
		);
	});

	it("clears a mapped selection when an overlay covers the content", async () => {
		await withSelection(new Text("underlying text", 0, 0), 20, "viewport", async (fixture) => {
			select(fixture, 0, 0, 9, 0);
			fixture.tui.showOverlay(new Text("overlay", 0, 0), { row: 0, col: 0, width: 20 });
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
		});
	});

	it("does not include rows clipped out of a non-scroll viewport", async () => {
		await withSelection(
			new Text("visible\nlast visible\nhidden", 0, 0),
			20,
			"viewport",
			async (fixture) => {
				select(fixture, 0, 0, 19, 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["visible\nlast visible"]);
			},
			2,
		);
	});

	it("binds lazy metadata to the rendered snapshot, not the current Text value", () => {
		const component = new Text("old text", 0, 0);
		const oldLines = component.render(20);
		component.setText("new text");
		const newLines = component.render(20);
		assert.equal(getSelectionMap(oldLines)?.[0]?.[0]?.source.text, "old text");
		assert.equal(getSelectionMap(newLines)?.[0]?.[0]?.source.text, "new text");
		assert.equal(getSelectionMap(newLines), getSelectionMap(newLines));
		newLines[0] = "mutated by a legacy wrapper";
		assert.equal(getSelectionMap(newLines), undefined);
	});

	it("copies repeated uses of a cached Text as separate blocks", async () => {
		const shared = new Text("repeat me", 0, 0);
		const nested = new Container();
		nested.addChild(shared);
		const container = new Container();
		container.addChild(shared);
		container.addChild(nested);
		await withSelection(container, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 8, 1);
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["repeat me\nrepeat me"]);
		});
	});

	it("does not turn an endpoint in trailing padding into a blank content line", async () => {
		const container = new Container();
		container.addChild(new Text("first", 0, 0));
		container.addChild(new Text("second", 0, 0));
		await withSelection(container, 20, "scroll", async (fixture) => {
			select(fixture, 5, 0, 5, 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["second"]);
		});
	});

	it("invalidates a mixed selection when its legacy portion changes", async () => {
		const container = new Container();
		let legacy = "old legacy text";
		container.addChild(new Text("mapped", 0, 0));
		container.addChild({ render: () => [legacy], invalidate: () => {} });
		await withSelection(container, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 14, 1);
			legacy = "new legacy text";
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
		});
	});

	it("invalidates selection when its scroll view is removed", async () => {
		await withSelection(new Text("old text", 0, 0), 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 7, 0);
			fixture.tui.setLayoutRoot(new Text("replacement", 0, 0));
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
		});
	});

	it("does not copy hidden viewport source through a transient flash", async () => {
		await withSelection(new Text("underlying text", 0, 0), 20, "viewport", async (fixture) => {
			select(fixture, 0, 0, 14, 0);
			fixture.tui.flash("covering flash");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
		});
	});

	it("falls back without copying an invisible wide glyph at a one-column viewport", async () => {
		const component = new Text("a\u754cb", 0, 0);
		const lines = component.render(1);
		assert.equal(getSelectionMap(lines), undefined);
		await withSelection(component, 1, "scroll", async (fixture) => {
			select(fixture, 0, 0, 0, lines.length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.ok(!fixture.copied[0]!.includes("\u754c"));
		});
	});

	it("does not attach guessed metadata when a background callback rewrites text", () => {
		const component = new Text("original", 0, 0, () => "replacement");
		assert.equal(getSelectionMap(component.render(20)), undefined);
	});
});
