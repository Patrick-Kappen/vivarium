import assert from "node:assert/strict";
import { test } from "node:test";
import { MarkdownSelection } from "../src/markdown-selection.ts";
import { getSelectionMap } from "../src/selection-map.ts";

function prose(collector: MarkdownSelection, value: string) {
	const lines = [value];
	collector.text(lines, 0);
	return collector.wrap([lines], 40);
}

test("paint registration and wrapping do not materialize copy sources", () => {
	const collector = new MarkdownSelection([]);
	const text = prose(collector, "plain text");
	const code = ["```", "  body", "```"];
	collector.code(code, "body", "  ");
	const wrapped = collector.wrap([code], 40);
	const prefixed = ["- plain text"];
	collector.decoratePrefix(prefixed, text, ["- "], true);
	assert.equal(collector.sources.length, 3);
	assert(collector.sources.every((slot) => slot.source === undefined));
	assert.equal(getSelectionMap(wrapped)?.[1]?.[0]?.source.text, "body");
	assert.equal(collector.sources[0]?.source, undefined);
	assert.equal(collector.sources[2]?.source, undefined);
	assert.equal(getSelectionMap(prefixed)?.[0]?.[0]?.source.text, "- plain text");
});

test("source identity survives either snapshot-resolution order", () => {
	for (const newestFirst of [false, true]) {
		const old = new MarkdownSelection([]);
		const before = prose(old, "same");
		const next = new MarkdownSelection(old.sources);
		const after = prose(next, "same");
		const first = getSelectionMap(newestFirst ? after : before)?.[0]?.[0]?.source;
		const second = getSelectionMap(newestFirst ? before : after)?.[0]?.[0]?.source;
		assert(first);
		assert.equal(first, second);
	}
});

test("deferred snapshots never adopt later source text", () => {
	const old = new MarkdownSelection([]);
	const before = prose(old, "old");
	const next = new MarkdownSelection(old.sources);
	const after = prose(next, "new");
	assert.equal(getSelectionMap(after)?.[0]?.[0]?.source.text, "new");
	assert.equal(getSelectionMap(before)?.[0]?.[0]?.source.text, "old");
	assert.notEqual(getSelectionMap(after)?.[0]?.[0]?.source, getSelectionMap(before)?.[0]?.[0]?.source);
});

test("unselected streaming renders share a bounded slot, not a chain of old recipes", () => {
	let collector = new MarkdownSelection([]);
	prose(collector, "first");
	const slot = collector.sources[0];
	for (let index = 0; index < 10000; index++) {
		collector = new MarkdownSelection(collector.sources);
		prose(collector, `update ${index}`);
		assert.equal(collector.sources[0], slot);
	}
	assert.deepEqual(Object.keys(slot!), []);
	const final = prose(collector, "final");
	assert.equal(getSelectionMap(final)?.[0]?.[0]?.source.text, "final");
});

test("deferred code validation retains original paint and rejects rewritten highlighters", () => {
	const collector = new MarkdownSelection([]);
	const code = ["```", "  original", "```"];
	collector.code(code, "original", "  ");
	const wrapped = collector.wrap([code], 40);
	code[1] = "  later mutation";
	assert.equal(getSelectionMap(wrapped)?.[1]?.[0]?.source.text, "original");

	const rewritten = new MarkdownSelection([]);
	const painted = ["```", "  visible replacement", "```"];
	rewritten.code(painted, "hidden original", "  ");
	const fallback = rewritten.wrap([painted], 40);
	assert(rewritten.sources.every((slot) => slot.source === undefined));
	assert.equal(getSelectionMap(fallback)?.[1], undefined);
	assert.deepEqual(getSelectionMap(fallback)?.[0], []);
	assert.deepEqual(getSelectionMap(fallback)?.[2], []);
});

test("deferred code sources retain original tabs and newlines", () => {
	const collector = new MarkdownSelection([]);
	const code = ["```", "  a   b", "  c", "```"];
	collector.code(code, "a   b\nc", "  ", "a\tb\r\nc");
	const wrapped = collector.wrap([code], 40);
	assert.equal(collector.sources[0]?.source, undefined);
	assert.equal(getSelectionMap(wrapped)?.[1]?.[0]?.source.text, "a\tb\r\nc");
	assert.equal(getSelectionMap(wrapped)?.[2]?.[0]?.source, getSelectionMap(wrapped)?.[1]?.[0]?.source);
});
