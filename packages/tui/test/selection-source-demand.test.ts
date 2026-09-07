import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "../src/components/text.ts";
import { getSelectionMap } from "../src/selection-map.ts";
import { type CopySourceCache, deferCopySource } from "../src/selection-source.ts";

function cacheOf(text: Text): CopySourceCache {
	return (text as unknown as { copySourceCache: CopySourceCache }).copySourceCache;
}

test("deferred source recipes run once and preserve already-resolved snapshots", () => {
	const cache: CopySourceCache = {};
	let calls = 0;
	const before = deferCopySource(cache, () => {
		calls++;
		return "before";
	});
	const after = deferCopySource(cache, () => {
		calls++;
		return "after";
	});
	assert.equal(calls, 0);
	const old = before();
	assert.equal(after().text, "after");
	assert.equal(before(), old);
	assert.equal(old.text, "before");
	assert.equal(calls, 2);
});

test("Text creates no copy source during updates or rendering", () => {
	const text = new Text("initial", 0, 0);
	for (let index = 0; index < 100; index++) {
		text.setText(`update ${index}`);
		text.render(40);
	}
	assert.equal(cacheOf(text).source, undefined);
	const lines = text.render(40);
	assert.equal(getSelectionMap(lines)?.[0]?.[0]?.source.text, "update 99");
	assert.equal(getSelectionMap(lines), getSelectionMap(lines));
});

test("Text source identity survives styling and width changes in either demand order", () => {
	for (const newestFirst of [false, true]) {
		const text = new Text("same", 0, 0);
		const before = text.render(10);
		text.setText("\x1b[31msame\x1b[0m");
		const after = text.render(20);
		const first = getSelectionMap(newestFirst ? after : before)?.[0]?.[0]?.source;
		assert(first);
		assert.equal(getSelectionMap(newestFirst ? before : after)?.[0]?.[0]?.source, first);
	}
});

test("Text demand uses the painted source rather than the current streaming text", () => {
	const text = new Text("old", 0, 0);
	const before = text.render(10);
	text.setText("new");
	const after = text.render(10);
	assert.equal(getSelectionMap(after)?.[0]?.[0]?.source.text, "new");
	assert.equal(getSelectionMap(before)?.[0]?.[0]?.source.text, "old");
});

test("rewriting backgrounds fail closed before resolving the hidden source", () => {
	const text = new Text("private", 0, 0, () => "visible");
	const lines = text.render(7);
	assert.equal(cacheOf(text).source, undefined);
	assert.equal(getSelectionMap(lines), undefined);
	assert.equal(cacheOf(text).source, undefined);
});
