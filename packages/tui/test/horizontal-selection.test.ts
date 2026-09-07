import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { getClippedSelectionMap, getViewportSelectionMap } from "../src/selection-layout.ts";
import { getSelectionMap, selectionText, snapshotSelectionLines } from "../src/selection-map.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { select, withSelection } from "./selection-test-utils.ts";

describe("horizontal source-aware selection", () => {
	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`copies columns in screen row order with tabs, without layout spaces (${mode})`, async () => {
			const stack = new HStack(
				[
					{ component: new Text("left\n  next", 0, 0), basis: 7, shrink: 0 },
					{ component: new Text("right\nlast", 0, 0), basis: 7, shrink: 0 },
				],
				{ gap: 2 },
			);
			await withSelection(stack, 16, mode, async (fixture) => {
				select(fixture, 15, 1, 0, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["left\tright\n  next\tlast"]);
			});
		});

		it(`keeps repeated cached sources in separate horizontal lanes (${mode})`, async () => {
			const shared = new Text("same", 0, 0);
			const stack = new HStack(
				[
					{ component: shared, basis: 5, shrink: 0 },
					{ component: shared, basis: 5, shrink: 0 },
				],
				{ gap: 2 },
			);
			await withSelection(stack, 12, mode, async (fixture) => {
				select(fixture, 0, 0, 11, 0);
				fixture.tui.renderNow();
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["same\tsame"]);
			});
		});

		it(`does not copy or highlight gaps or a neighbouring trailing anchor (${mode})`, async () => {
			const stack = new HStack([
				{ component: new Text("abc  ", 0, 0), basis: 3, shrink: 0 },
				{ component: new Text("XYZ", 0, 0), basis: 3, shrink: 0 },
			]);
			await withSelection(stack, 8, mode, async (fixture) => {
				fixture.terminal.writes.length = 0;
				select(fixture, 6, 0, 7, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
				assert.ok(!fixture.terminal.writes.join("").includes("\x1b[7m"));
				select(fixture, 3, 0, 5, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["XYZ"]);
			});
		});

		it(`preserves logical wraps when only one lane contributes content (${mode})`, async () => {
			const source = "alpha beta\n\n gamma  ";
			const stack = new HStack(
				[
					{ component: new Text(source, 0, 0), basis: 5, shrink: 0 },
					{ component: new Text("", 0, 0), basis: 4, shrink: 0 },
				],
				{ gap: 2 },
			);
			await withSelection(stack, 11, mode, async (fixture) => {
				select(fixture, 0, 0, 10, stack.render(11).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, [source]);
			});
		});

		it(`forwards nested horizontal lanes through Box padding (${mode})`, async () => {
			const inner = new HStack(
				[
					{ component: new Text("one", 0, 0), basis: 3, shrink: 0 },
					{ component: new Text("two", 0, 0), basis: 3, shrink: 0 },
				],
				{ gap: 1 },
			);
			const box = new Box(1, 1);
			box.addChild(
				new HStack(
					[
						{ component: inner, basis: 7, shrink: 0 },
						{ component: new Text("tail", 0, 0), basis: 4, shrink: 0 },
					],
					{ gap: 2 },
				),
			);
			await withSelection(box, 15, mode, async (fixture) => {
				select(fixture, 0, 0, 14, 2);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["one\ttwo\ttail"]);
			});
		});

		it(`does not restore clipped source between rows (${mode})`, async () => {
			const rendered = new Text("safeSECRET\nnextSECRET", 0, 0).render(10);
			const stack = new HStack([
				{ component: { render: () => rendered, invalidate: () => {} }, basis: 4, shrink: 0 },
			]);
			await withSelection(stack, 4, mode, async (fixture) => {
				select(fixture, 0, 0, 3, 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["safe\nnext"]);
			});
		});

		it(`omits partially clipped wide graphemes from copy and highlight (${mode})`, async () => {
			const rendered = new Text("ab\u754cZ\ncd\u754cQ", 0, 0).render(5);
			const stack = new HStack([
				{ component: { render: () => rendered, invalidate: () => {} }, basis: 3, shrink: 0 },
			]);
			await withSelection(stack, 3, mode, async (fixture) => {
				fixture.terminal.writes.length = 0;
				select(fixture, 0, 0, 2, 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["ab\ncd"]);
				const writes = fixture.terminal.writes.join("").replace(/\x1b\]8;;\x07/g, "");
				assert.ok(writes.includes("\x1b[7mab\x1b[27m"));
				assert.ok(!writes.includes("\x1b[7mab \x1b[27m"));
			});
		});

		it(`copies a partially clipped expanded tab and highlights only its visible cells (${mode})`, async () => {
			const rendered = new Text("\tX", 0, 0).render(10);
			const stack = new HStack([
				{ component: { render: () => rendered, invalidate: () => {} }, basis: 2, shrink: 0 },
			]);
			await withSelection(stack, 2, mode, async (fixture) => {
				fixture.terminal.writes.length = 0;
				select(fixture, 0, 0, 1, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["\t"]);
				const writes = fixture.terminal.writes.join("").replace(/\x1b\]8;;\x07/g, "");
				assert.ok(writes.includes("\x1b[7m  \x1b[27m"));
			});
		});

		it(`retains legacy trimming in a mixed mapped/legacy row (${mode})`, async () => {
			const stack = new HStack(
				[
					{ component: new Text("left  ", 0, 0), basis: 6, shrink: 0 },
					{ component: { render: () => ["|old|  "], invalidate: () => {} }, basis: 7, shrink: 0 },
				],
				{ gap: 1 },
			);
			await withSelection(stack, 14, mode, async (fixture) => {
				select(fixture, 0, 0, 13, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["left  \t|old|"]);
			});
		});
	}

	for (const align of ["start", "center", "end"] as const) {
		it(`excludes ${align}-alignment padding`, async () => {
			const stack = new HStack(
				[
					{ component: new Text("a\nb\nc", 0, 0), basis: 3, shrink: 0 },
					{ component: new Text("x", 0, 0), basis: 3, shrink: 0 },
				],
				{ gap: 2, align },
			);
			await withSelection(
				stack,
				8,
				"viewport",
				async (fixture) => {
					select(fixture, 0, 0, 7, 2);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [
						{ start: "a\tx\nb\nc", center: "a\nb\tx\nc", end: "a\nb\nc\tx" }[align],
					]);
				},
				3,
			);
		});
	}

	it("clips oversized nested children to their parent, including scroll-pane copying", async () => {
		const pane = new ScrollView(new Text("safeSECRET\nnextSECRET\nlastSECRET", 0, 0));
		const inner = new HStack([{ component: pane, basis: 10, minSize: 10, shrink: 0 }]);
		const root = new HStack(
			[
				{ component: inner, basis: 4, shrink: 0 },
				{ component: new Text("R1\nR2", 0, 0), basis: 2, shrink: 0 },
			],
			{ gap: 1 },
		);
		const frame = renderLayoutFrame(root, 7, 2, () => {});
		assert.deepEqual(frame.lines.map(stripTerminalSequences), ["safe R1", "next R2"]);
		await withSelection(
			root,
			7,
			"viewport",
			async (fixture) => {
				fixture.terminal.sendInput("\x1b[<0;1;1M");
				pane.scrollTo(1);
				fixture.tui.renderNow();
				fixture.terminal.sendInput("\x1b[<32;4;2M");
				fixture.terminal.sendInput("\x1b[<0;4;2m");
				fixture.tui.renderNow();
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["safe\nnext\nlast"]);
			},
			2,
		);
	});

	it("does not bridge entirely hidden rows when clipping from the left", () => {
		const lines = new Text("XXXXsafe\nHIDE\nXXXXnext", 0, 0).render(8);
		const map = getClippedSelectionMap(lines, 4, 8);
		assert.equal(
			selectionText(lines, map, 0, 2, () => ({ start: 4, end: 8 }), 8),
			"safe\nnext",
		);
	});

	it("keeps painted legacy snapshots independent of later array mutation", () => {
		const lines = ["old"];
		const root = new HStack([{ component: { render: () => lines, invalidate: () => {} }, basis: 4 }]);
		const frame = renderLayoutFrame(root, 4, 1, () => {});
		lines[0] = "new";
		assert.equal(
			selectionText(frame.lines, getViewportSelectionMap(frame), 0, 0, () => ({ start: 0, end: 4 }), 4),
			"old",
		);
	});

	it("snapshots sparse arrays without expanding holes", () => {
		const lines: string[] = [];
		lines.length = 1_000_000_000;
		lines[999_999_999] = "last";
		const snapshot = snapshotSelectionLines(lines);
		assert.equal(snapshot.length, lines.length);
		assert.deepEqual(Object.keys(snapshot), ["999999999"]);
		lines[999_999_999] = "changed";
		assert.equal(snapshot[999_999_999], "last");
		assert.equal(getClippedSelectionMap(snapshot, 0, 2), undefined);
	});

	it("uses row order rather than interleaving logical paragraphs across wrapped columns", async () => {
		const stack = new HStack(
			[
				{ component: new Text("alpha beta", 0, 0), basis: 5, shrink: 0 },
				{ component: new Text("gamma delta", 0, 0), basis: 5, shrink: 0 },
			],
			{ gap: 2 },
		);
		await withSelection(stack, 12, "viewport", async (fixture) => {
			select(fixture, 0, 0, 11, 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["alpha\tgamma\nbeta\tdelta"]);
		});
	});

	it("does not copy zero-width or hidden columns", async () => {
		const stack = new HStack(
			[
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				{ component: new Text("also hidden", 0, 0), visible: () => false },
				{ component: new Text("shown", 0, 0), basis: 7, shrink: 0 },
			],
			{ gap: 2 },
		);
		await withSelection(stack, 9, "viewport", async (fixture) => {
			select(fixture, 0, 0, 8, 0);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["shown"]);
		});
	});

	it("snapshots legacy children in the horizontal string-array facade", () => {
		const child = ["old"];
		const stack = new HStack([{ component: { render: () => child, invalidate: () => {} }, basis: 4 }]);
		const lines = stack.render(4);
		child[0] = "new";
		assert.equal(
			selectionText(lines, getSelectionMap(lines), 0, 0, () => ({ start: 0, end: 4 }), 4),
			"old",
		);
	});

	it("invalidates a mapped snapshot after deleting an array element", () => {
		const lines = new Text("old", 0, 0).render(4);
		delete lines[0];
		assert.equal(getSelectionMap(lines), undefined);
	});
});
