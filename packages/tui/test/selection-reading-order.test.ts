import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeHorizontalSelection } from "../src/selection-compose.ts";
import {
	type CopyOrder,
	type CopySource,
	type CopySpan,
	getSelectionMap,
	selectionText,
	setSelectionMap,
} from "../src/selection-map.ts";
import { select, withSelection } from "./selection-test-utils.ts";

function spans(text: string, start: number, column: number, source: CopySource, readingOrder?: CopyOrder): CopySpan[] {
	return [...text].map((_, index) => ({
		source,
		readingOrder,
		start: start + index,
		end: start + index + 1,
		columnStart: column + index,
		columnEnd: column + index + 1,
	}));
}

describe("explicit selection reading order", () => {
	it("does not bridge source gaps hidden by projection when regrouping columns", () => {
		const a = { text: "abcdef" };
		const b = { text: "UVWXYZ" };
		const left = { group: a, column: 0 };
		const right = { group: a, column: 1 };
		const source = ["abUV", "  WXcd", "efYZ"];
		setSelectionMap(source, () => [
			[...spans("ab", 0, 0, a, left), ...spans("UV", 0, 2, b, right)],
			[...spans("WX", 2, 2, b, right), ...spans("cd", 2, 4, a, left)],
			[...spans("ef", 4, 0, a, left), ...spans("YZ", 4, 2, b, right)],
		]);
		assert.equal(
			selectionText(source, getSelectionMap(source), 0, 2, () => ({ start: 0, end: 4 }), 4),
			"ab\nef\tUVWXYZ",
		);
		const painted = ["abUV", "  WX", "efYZ"];
		composeHorizontalSelection(painted, [{ lines: source, row: 0, column: 0, width: 4 }], 4);
		assert.equal(
			selectionText(painted, getSelectionMap(painted), 0, 2, () => ({ start: 0, end: 4 }), 4),
			"ab\nef\tUVWXYZ",
		);
	});

	it("retains both screen boundaries around a reordered group", () => {
		const a = { text: "a" };
		const b = { text: "B" };
		const lines = ["n B", "a x"];
		setSelectionMap(lines, () => [
			[
				...spans("n", 0, 0, { text: "n" }).map((span) => ({ ...span, flow: "note" })),
				...spans("B", 0, 2, b, { group: a, column: 1 }),
			],
			[
				...spans("a", 0, 0, a, { group: a, column: 0 }),
				...spans("x", 0, 2, { text: "x" }).map((span) => ({ ...span, flow: "tail" })),
			],
		]);
		assert.equal(
			selectionText(lines, getSelectionMap(lines), 0, 1, () => ({ start: 0, end: 3 }), 3),
			"n\ta\tB\tx",
		);
	});

	it("keeps explicit columns and groups separate even when their sources are shared", () => {
		const source = { text: "A" };
		const otherGroup = { text: "row" };
		const columns = ["A A"];
		setSelectionMap(columns, () => [
			[
				...spans("A", 0, 0, source, { group: source, column: 0 }),
				...spans("A", 0, 2, source, { group: source, column: 1 }),
			],
		]);
		assert.equal(
			selectionText(columns, getSelectionMap(columns), 0, 0, () => ({ start: 0, end: 3 }), 3),
			"A\tA",
		);
		const rows = ["A", "A"];
		setSelectionMap(rows, () => [
			spans("A", 0, 0, source, { group: source, column: 0 }),
			spans("A", 0, 0, source, { group: otherGroup, column: 0 }),
		]);
		assert.equal(
			selectionText(rows, getSelectionMap(rows), 0, 1, () => ({ start: 0, end: 1 }), 1),
			"A\nA",
		);
	});

	it("invalidates a selection when only its reading order changes", async () => {
		const a = { text: "a" };
		const b = { text: "b" };
		let reversed = false;
		const component = {
			invalidate() {},
			render() {
				const flipped = reversed;
				const lines = ["a b"];
				setSelectionMap(lines, () => [
					[
						...spans("a", 0, 0, a, { group: a, column: flipped ? 1 : 0 }),
						...spans("b", 0, 2, b, { group: a, column: flipped ? 0 : 1 }),
					],
				]);
				return lines;
			},
		};
		await withSelection(component, 3, "scroll", async (fixture) => {
			select(fixture, 0, 0, 2, 0);
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["a\tb"]);
			reversed = true;
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
			select(fixture, 0, 0, 2, 0);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.equal(fixture.copied.at(-1), "b\ta");
		});
	});
});
