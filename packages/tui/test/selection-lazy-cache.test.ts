import assert from "node:assert/strict";
import { test } from "node:test";
import { preserveSelection } from "../src/preserve-selection.ts";
import { getSelectionMap, joinSelectionMaps, setSelectionMap, snapshotSelectionLines } from "../src/selection-map.ts";
import { Container } from "../src/tui.ts";

function mapped(text: string, source = { text }) {
	const lines = [text];
	setSelectionMap(lines, () => [[{ columnStart: 0, columnEnd: text.length, source, start: 0, end: text.length }]]);
	return lines;
}

test("a transcript resolves only requested child maps, retaining array slicing", () => {
	const calls = Array(200).fill(0);
	const children = calls.map((_, index) => {
		const lines = [`row ${index}`];
		setSelectionMap(lines, () => {
			calls[index]++;
			return [[{ columnStart: 0, columnEnd: 1, source: { text: String(index) }, start: 0, end: 1 }]];
		});
		return lines;
	});
	const output = children.flat();
	joinSelectionMaps(output, children);
	const outer = [...output];
	joinSelectionMaps(outer, [output]);
	const map = getSelectionMap(outer)!;
	assert.equal(
		calls.reduce((a, b) => a + b),
		0,
	);
	assert.equal(map.slice(150, 151)[0]?.[0]?.source.text, "150");
	assert.equal(
		calls.reduce((a, b) => a + b),
		1,
	);
	assert.equal(map[150]?.[0]?.breakBefore, true);
	assert.equal(calls[150], 1);
	Object.freeze(map);
	assert.equal(map[151]?.[0]?.source.text, "151");
	assert.equal(
		calls.reduce((a, b) => a + b),
		2,
	);
});

test("Container reuses unchanged output but detects mutable child and output aliases", () => {
	const child = mapped("first");
	const container = new Container();
	container.addChild({ render: () => child, invalidate() {} });
	const first = container.render(20);
	assert.equal(container.render(20), first);
	child[0] = "other";
	const other = container.render(20);
	assert.notEqual(other, first);
	assert.equal(other[0], "other");
	assert.equal(getSelectionMap(other), undefined);
	assert.equal(getSelectionMap(first)?.[0]?.[0]?.source.text, "first");
	other[0] = "external rewrite";
	assert.equal(container.render(20)[0], "other");
});

test("same visible text with new source identity invalidates the Container cache", () => {
	const child = mapped("same");
	const container = new Container();
	container.addChild({ render: () => child, invalidate() {} });
	const before = container.render(20);
	const source = { text: "same" };
	setSelectionMap(child, () => [[{ columnStart: 0, columnEnd: 4, source, start: 0, end: 4 }]]);
	const after = container.render(20);
	assert.notEqual(after, before);
	assert.equal(getSelectionMap(after)?.[0]?.[0]?.source, source);
	assert.notEqual(container.render(19), after);
	container.invalidate();
	assert.notEqual(container.render(20), after);
});

test("verified frame metadata is reused, but changed paint or placement is revalidated", () => {
	const input = mapped("a");
	const first = ["|a|"];
	preserveSelection(first, input, { row: 0, column: 1, width: 1 });
	const expected = getSelectionMap(first);
	const again = ["|a|"];
	preserveSelection(again, input, { row: 0, column: 1, width: 1 });
	assert.equal(getSelectionMap(again), expected);
	const restyled = ["\x1b[31m|a|\x1b[0m"];
	preserveSelection(restyled, input, { row: 0, column: 1, width: 1 });
	assert.notEqual(getSelectionMap(restyled), expected);
	assert.equal(getSelectionMap(restyled)?.[0]?.[0]?.source.text, "a");
	const source = { text: "a" };
	setSelectionMap(input, () => [[{ columnStart: 0, columnEnd: 1, source, start: 0, end: 1 }]]);
	const reattributed = ["|a|"];
	preserveSelection(reattributed, input, { row: 0, column: 1, width: 1 });
	assert.equal(getSelectionMap(reattributed)?.[0]?.[0]?.source, source);
	const changed = ["|x|"];
	preserveSelection(changed, input, { row: 0, column: 1, width: 1 });
	assert.equal(getSelectionMap(changed), undefined);
	const moved = ["|a|"];
	preserveSelection(moved, input, { row: 0, column: 0, width: 1 });
	assert.equal(getSelectionMap(moved), undefined);
});

test("retained frame snapshots bind original paint, never later mutable output", () => {
	const input = mapped("a");
	const output = ["|a|"];
	preserveSelection(output, input, { row: 0, column: 1, width: 1 });
	const retained = snapshotSelectionLines(output);
	output[0] = "|x|";
	assert.equal(getSelectionMap(output), undefined);
	assert.equal(getSelectionMap(retained)?.[0]?.[0]?.source.text, "a");
});
