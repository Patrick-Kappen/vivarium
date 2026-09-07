import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { getScrollViewBox, renderLayoutFrame } from "../src/layout.ts";
import { MarkdownSelection } from "../src/markdown-selection.ts";
import { getClippedSelectionMap } from "../src/selection-layout.ts";
import {
	type CopySpan,
	getSelectionMap,
	setSelectionMap,
	snapshotSelectionLines,
	trackSelectionLines,
} from "../src/selection-map.ts";
import { select, withSelection } from "./selection-test-utils.ts";

// Vivarium PR #17: stale overlays and transcript-sized work on hot selection reads.
describe("selection review regressions", () => {
	for (const change of ["update", "replace", "uncover"] as const) {
		it(`clears stale selection when an overlay changes without an empty stack (${change})`, async () => {
			await withSelection(new Text("background", 0, 0), 30, "viewport", async (fixture) => {
				fixture.tui.showOverlay(new Text("omega", 0, 0), { row: 0, col: 0, width: 20 });
				const content = new Text("alpha", 0, 0);
				const handle = fixture.tui.showOverlay(content, { row: 0, col: 0, width: 20 });
				fixture.tui.renderNow();
				select(fixture, 0, 0, 4, 0);
				assert.equal(fixture.tui.hasActiveSelection(), true);
				if (change === "update") content.setText("omega");
				else if (change === "replace")
					fixture.tui.showOverlay(new Text("omega", 0, 0), { row: 0, col: 0, width: 20 });
				else handle.hide();
				fixture.tui.renderNow();
				assert.equal(fixture.tui.hasActiveSelection(), false);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
				assert.deepEqual(fixture.copied, []);
			});
		});
	}

	it("preserves overlay selection across styling and unrelated-row changes", async () => {
		await withSelection(new Text("background", 0, 0), 30, "viewport", async (fixture) => {
			const content = new Text("alpha\nold", 0, 0);
			fixture.tui.showOverlay(content, { row: 0, col: 0, width: 20 });
			fixture.tui.renderNow();
			select(fixture, 0, 0, 4, 0);
			content.setText("\x1b[31malpha\x1b[0m\nnew");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["alpha"]);
		});
	});

	it("reuses the owned 100k-row Text snapshot across wheel/layout frames", () => {
		const text = new Text(`${"row\n".repeat(99_999)}row`, 0, 0);
		const scroll = new ScrollView(text);
		const render = () =>
			getScrollViewBox(
				renderLayoutFrame(scroll, 40, 20, () => {}),
				scroll,
			)!.scrollContentLines!;
		const first = render();
		assert.equal(first.length, 100_000);
		assert.equal(Object.isFrozen(first), true);
		for (let frame = 0; frame < 20; frame++) {
			scroll.scrollBy(1);
			assert.ok(render() === first, "unchanged render frames must reuse the owned snapshot");
		}
		text.setText("changed");
		assert.notEqual(render(), first);
		assert.equal(first[0]?.trim(), "row");
	});

	it("does not scan owned rows on repeated metadata reads", () => {
		const lines = Array.from({ length: 100_000 }, () => "row");
		setSelectionMap(lines, () => []);
		const snapshot = snapshotSelectionLines(lines);
		let scanned = 0;
		const restore: Array<() => void> = [];
		try {
			for (const method of ["some", "every"] as const) {
				const original = Array.prototype[method];
				const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, method)!;
				restore.push(() => {
					Object.defineProperty(Array.prototype, method, descriptor);
				});
				Object.defineProperty(Array.prototype, method, {
					value: function (this: unknown[], ...args: Parameters<typeof original>) {
						if (this.length === lines.length) scanned += this.length;
						return original.apply(this, args);
					},
				});
			}
			for (let index = 0; index < 20; index++) assert.deepEqual(getSelectionMap(snapshot), []);
			assert.equal(scanned, 0);
		} finally {
			for (const reset of restore) reset();
		}
	});

	for (const mutation of ["assign", "delete", "define", "truncate"] as const) {
		it(`keeps legacy mutation conservative and old snapshots immutable (${mutation})`, () => {
			const text = new Text("original", 0, 0, (value) => value);
			const lines = text.render(20);
			const before = snapshotSelectionLines(lines);
			if (mutation === "assign") lines[0] = "rewritten";
			else if (mutation === "delete") delete lines[0];
			else if (mutation === "define") Object.defineProperty(lines, "0", { value: "rewritten" });
			else lines.length = 0;
			assert.equal(getSelectionMap(lines), undefined);
			assert.notEqual(snapshotSelectionLines(lines), before);
			assert.equal(getSelectionMap(before)?.[0]?.[0]?.source.text, "original");
		});
	}

	it("validates untracked mutable output, including non-enumerable and deleted rows", () => {
		const lines = ["one", "two"];
		const before = snapshotSelectionLines(lines);
		assert.equal(snapshotSelectionLines(lines), before);
		Object.defineProperty(lines, "0", { value: "new", enumerable: false });
		const after = snapshotSelectionLines(lines);
		assert.notEqual(after, before);
		assert.equal(after[0], "new");
		delete lines[1];
		assert.equal(Object.hasOwn(snapshotSelectionLines(lines), 1), false);
		assert.equal(before[1], "two");
	});

	it("does not retain Box metadata after an equal-pixel legacy rewrite", () => {
		const child = new Text("\tabc", 0, 0);
		const box = new Box(0, 0);
		box.addChild(child);
		const before = box.render(20);
		assert.equal(getSelectionMap(before)?.[0]?.[0]?.source.text, "\tabc");
		const lines = child.render(20);
		lines[0] = `${lines[0]}`;
		const after = box.render(20);
		assert.notEqual(after, before);
		assert.equal(getSelectionMap(after)?.[0]?.[0]?.source.legacy, true);
	});

	it("recomputes legacy clip rows even when a caller reuses its map object", () => {
		const lines = ["", "alpha"];
		const map = [[], undefined];
		setSelectionMap(lines, () => map);
		const before = getClippedSelectionMap(lines, 0, 5);
		lines[1] = "omega";
		setSelectionMap(lines, () => map);
		const after = getClippedSelectionMap(lines, 0, 5);
		assert.notEqual(after, before);
		assert.equal(before?.[1]?.[0]?.source.text, "alpha");
		assert.equal(after?.[1]?.[0]?.source.text, "omega");
	});

	it("never trusts a mutable getter installed on tracked output", () => {
		const lines = trackSelectionLines(["one"]);
		let value = "one";
		Object.defineProperty(lines, "0", { get: () => value });
		const before = snapshotSelectionLines(lines);
		value = "two";
		assert.notEqual(snapshotSelectionLines(lines), before);
	});

	it("caches clipped projections by snapshot and bounds, not only by rendered pixels", () => {
		const lines = new Text("abcdef\nghijkl", 0, 0).render(6);
		const snapshot = snapshotSelectionLines(lines);
		const first = getClippedSelectionMap(snapshot, 1, 4);
		assert.ok(first);
		assert.equal(getClippedSelectionMap(snapshot, 1, 4), first);
		const narrower = getClippedSelectionMap(snapshot, 2, 3);
		assert.notEqual(narrower, first);
		assert.ok(narrower?.flat().every((span) => span && span.columnStart >= 2 && span.columnEnd <= 3));
		lines[0] = "XXXXXX";
		assert.equal(getClippedSelectionMap(snapshotSelectionLines(lines), 1, 4), undefined);
		assert.equal(first[0]?.[0]?.source.text, "abcdef\nghijkl");
	});

	it("reflows 10k fragments with linear string slicing and bounded span visits", (t) => {
		const line = "a ".repeat(10_000).trimEnd();
		const block = [line];
		let visits = 0;
		const source = { text: line };
		const spans: CopySpan[] = Array.from({ length: line.length }, (_, index) => ({
			get columnStart() {
				visits++;
				return index;
			},
			columnEnd: index + 1,
			start: index,
			end: index + 1,
			source,
		}));
		setSelectionMap(block, () => [spans]);
		const rendered = new MarkdownSelection([]).wrap([block], 1);
		let sliced = 0;
		const slice = String.prototype.slice;
		t.mock.method(String.prototype, "slice", function (this: string, start = 0, end = this.length) {
			if (this.valueOf() === line) sliced += Math.max(0, end - start);
			return slice.call(this, start, end);
		});
		const map = getSelectionMap(rendered);
		assert.equal(map?.length, 10_000);
		assert.ok(sliced <= line.length * 2, `sliced ${sliced} units for ${line.length} input units`);
		assert.ok(visits <= spans.length * 50, `${visits} span visits`);
		assert.equal(map?.[9_999]?.[0]?.start, 19_998);
		t.diagnostic(`${sliced} sliced source units; ${visits} span visits for ${spans.length} spans`);
	});
});
