import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getSelectionMap } from "../src/selection-map.ts";
import { Container } from "../src/tui.ts";
import { select, withSelection } from "./selection-test-utils.ts";

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

describe("source-aware vertical composition", () => {
	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`copies through nested Box padding and backgrounds (${mode})`, async () => {
			for (const width of [20, 40]) {
				const source = "first logical line that wraps\n\n\tindented code  ";
				const inner = new Box(2, 1, (text) => `\x1b[44m${text}\x1b[49m`);
				inner.addChild(new Text(source, 1, 1));
				const outer = new Box(1, 1);
				outer.addChild(inner);
				outer.addChild(new Text("tail", 0, 0));
				await withSelection(outer, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, outer.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [`${source}\ntail`]);
				});
			}
		});

		it(`excludes VStack gaps, allocated padding and hidden/clipped children (${mode})`, async () => {
			const stack = new VStack(
				[
					{ component: new Text("first\nclipped secret", 0, 0), basis: 1, shrink: 0 },
					{ component: new Text("hidden secret", 0, 0), visible: () => false },
					{ component: new Text("last", 0, 0), basis: 3, shrink: 0 },
				],
				{ gap: 2 },
			);
			await withSelection(stack, 20, mode, async (fixture) => {
				select(fixture, 0, 0, 19, stack.render(20).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["first\nlast"]);
			});
		});

		it(`keeps repeated cached Text occurrences separate across stack gaps (${mode})`, async () => {
			const shared = new Text("repeat", 0, 0);
			const stack = new VStack([shared, shared], { gap: 3 });
			await withSelection(stack, 20, mode, async (fixture) => {
				select(fixture, 0, 0, 19, 4);
				fixture.tui.renderNow();
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["repeat\nrepeat"]);
			});
		});

		it(`does not copy or highlight Box padding or a VStack gap (${mode})`, async () => {
			const box = new Box(2, 1);
			box.addChild(new Text("content", 0, 0));
			const stack = new VStack([box, new Text("last", 0, 0)], { gap: 2 });
			await withSelection(stack, 20, mode, async (fixture) => {
				fixture.terminal.writes.length = 0;
				select(fixture, 0, 1, 1, 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
				select(fixture, 0, 3, 19, 3);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
				assert.ok(!fixture.terminal.writes.join("").includes("\x1b[7m"));
			});
		});
	}

	it("keeps logical source identity stable across measurement widths and style invalidation", () => {
		const component = new Text("stable logical text", 0, 0);
		const original = getSelectionMap(component.render(30))?.[0]?.[0]?.source;
		component.render(10);
		component.invalidate();
		assert.equal(getSelectionMap(component.render(30))?.[0]?.[0]?.source, original);
		component.setText("\x1b[31mstable logical text\x1b[0m");
		assert.equal(getSelectionMap(component.render(30))?.[0]?.[0]?.source, original);
	});

	it("forks Box snapshots when equal pixels have different logical text, without repainting", () => {
		const text = new Text("\tX", 0, 0);
		let paints = 0;
		const box = new Box(1, 1, (line) => {
			paints++;
			return line;
		});
		box.addChild(text);
		const before = box.render(20);
		const calls = paints;
		text.setText("   X");
		const after = box.render(20);
		assert.deepEqual(after, before);
		assert.notEqual(after, before);
		assert.equal(paints, calls + 1, "only the background sample should run on a painting cache hit");
		assert.equal(getSelectionMap(before)?.[1]?.[0]?.source.text, "\tX");
		assert.equal(getSelectionMap(after)?.[1]?.[0]?.source.text, "   X");
		assert.equal(box.render(20), after, "unchanged child snapshots should still reuse the Box result");
	});

	it("invalidates selection on equal-looking source changes inside a cached Box", async () => {
		const text = new Text("\tX", 0, 0);
		const box = new Box(1, 1);
		box.addChild(text);
		await withSelection(box, 20, "scroll", async (fixture) => {
			select(fixture, 1, 1, 4, 1);
			text.setText("   X");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
			select(fixture, 1, 1, 4, 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["   X"]);
		});
	});

	it("preserves legacy row trimming while excluding only Box-owned padding", async () => {
		const box = new Box(2, 1);
		box.addChild({ render: () => ["text   suffix", "", "  last  "], invalidate: () => {} });
		await withSelection(box, 20, "scroll", async (fixture) => {
			select(fixture, 2, 1, 8, 1);
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["text"]);
			select(fixture, 0, 0, 19, 4);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["text", "text   suffix\n\n  last"]);
		});
	});

	it("does not strip unknown frame characters when forwarding a legacy child", async () => {
		const box = new Box(2, 1);
		box.addChild({ render: () => ["| HEADER |", "|body|"], invalidate: () => {} });
		await withSelection(box, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 19, 3);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["| HEADER |\n|body|"]);
		});
	});

	it("forwards metadata through the ScrollView string-array facade with a reserved scrollbar column", async () => {
		const source = "alpha beta gamma delta epsilon";
		const component = new ScrollView(new Text(source, 0, 0), { scrollbar: "always" });
		await withSelection(component, 14, "implicit", async (fixture) => {
			select(fixture, 0, 0, 13, component.render(14).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, [source]);
		});
	});

	it("keeps source coordinates stable while dragging through scrolled Box content", async () => {
		const box = new Box(2, 1);
		box.addChild(new Text(Array.from({ length: 20 }, (_, row) => `line ${row}`).join("\n"), 0, 0));
		await withSelection(
			box,
			20,
			"scroll",
			async (fixture) => {
				fixture.terminal.sendInput("\x1b[<0;3;2M");
				fixture.scroll.scrollTo(3);
				fixture.tui.renderNow();
				fixture.terminal.sendInput("\x1b[<32;8;4M");
				fixture.terminal.sendInput("\x1b[<0;8;4m");
				fixture.tui.renderNow();
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["line 0\nline 1\nline 2\nline 3\nline 4\nline 5"]);
			},
			6,
		);
	});

	it("does not inherit metadata through a Box background function that rewrites content", () => {
		const box = new Box(1, 1, () => "replacement");
		box.addChild(new Text("original", 0, 0));
		assert.equal(getSelectionMap(box.render(20)), undefined);
	});
});
