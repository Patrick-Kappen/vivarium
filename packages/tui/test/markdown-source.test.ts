import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MarkdownSource } from "../src/markdown-source.ts";

describe("Markdown normalization provenance", () => {
	it("preserves the established normalization and exact full source", () => {
		for (const text of ["plain", "a\tb\r\nc\rd\n", "\t\t\r\n", "\ud83d\ude00\t\r\ne\u0301", ""]) {
			const source = new MarkdownSource(text);
			assert.equal(source.text, text.replace(/\t/g, "   ").replace(/\r\n|\r/g, "\n"));
			assert.equal(source.slice(0, source.text.length), text);
		}
	});

	it("maps partial expanded tabs but rejects partial-tab lexer slices", () => {
		const source = new MarkdownSource("a\tb\r\nc");
		assert.deepEqual(source.range(2, 3), { start: 1, end: 2 });
		assert.deepEqual(source.range(2, 2), { start: 1, end: 1 });
		assert.equal(source.slice(2, 2), undefined);
		assert.equal(source.slice(2, 3), undefined);
		assert.equal(source.slice(1, 4), "\t");
		assert.equal(source.slice(5, 6), "\r\n");
		assert.equal(source.slice(6, 7), "c");
	});

	it("keeps exact boundaries over many mixed edits", () => {
		const original = "a\tb\r\nc\rd\n".repeat(1000);
		const source = new MarkdownSource(original);
		let normalized = 0;
		for (const match of original.matchAll(/\r\n|[\s\S]/g)) {
			const width = match[0] === "\t" ? 3 : 1;
			assert.equal(source.slice(normalized, normalized + width), match[0]);
			normalized += width;
		}
	});

	it("rejects invalid offsets", () => {
		const source = new MarkdownSource("x\t");
		for (const [start, end] of [
			[-1, 0],
			[2, 1],
			[0, 5],
			[0.5, 1],
			[0, Number.NaN],
		])
			assert.throws(() => source.range(start, end), RangeError);
	});
});
