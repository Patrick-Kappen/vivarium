import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, wrapTextWithAnsi, wrapTextWithAnsiRanges } from "../src/utils.ts";

describe("source ranges recorded during ANSI wrapping", () => {
	it("retains the whitespace omitted at a soft wrap in the source interval", () => {
		const source = "alpha   beta gamma";
		const result = wrapTextWithAnsiRanges(source, 8);
		assert.deepEqual(result.lines, ["alpha", "beta", "gamma"]);
		assert.deepEqual(result.ranges, [
			{ start: 0, end: 5 },
			{ start: 8, end: 12 },
			{ start: 13, end: 18 },
		]);
		assert.equal(source.slice(result.ranges[0]!.start, result.ranges[2]!.end), source);
		assert.equal(source.slice(2, result.ranges[1]!.start + 2), "pha   be");
	});

	it("keeps explicit newline sequences and blank lines distinct from soft wraps", () => {
		const source = "one\r\n\r\ntwo\rthree\nfour";
		const result = wrapTextWithAnsiRanges(source, 20);
		assert.deepEqual(result.lines, ["one", "", "two", "three", "four"]);
		assert.deepEqual(result.ranges, [
			{ start: 0, end: 3 },
			{ start: 5, end: 5 },
			{ start: 7, end: 10 },
			{ start: 11, end: 16 },
			{ start: 17, end: 21 },
		]);
	});

	it("does not mistake styling carried across real lines for source characters", () => {
		const source = "\x1b[31mone\n\ntwo\x1b[0m";
		const result = wrapTextWithAnsiRanges(source, 20);
		assert.deepEqual(result.ranges, [
			{ start: 0, end: 8 },
			{ start: 9, end: 9 },
			{ start: 10, end: 17 },
		]);
	});

	it("records UTF-16 offsets without splitting wide or combining graphemes", () => {
		const source = "A\u754ce\u0301\ud83d\udc69\u200d\ud83d\udcbbZ";
		const result = wrapTextWithAnsiRanges(source, 2);
		assert.deepEqual(result.lines, ["A", "\u754c", "e\u0301", "\ud83d\udc69\u200d\ud83d\udcbb", "Z"]);
		assert.deepEqual(result.ranges, [
			{ start: 0, end: 1 },
			{ start: 1, end: 2 },
			{ start: 2, end: 4 },
			{ start: 4, end: 9 },
			{ start: 9, end: 10 },
		]);
	});

	it("leaves tabs intact for a caller that has not expanded them", () => {
		const source = "one\n\ttwo  ";
		const result = wrapTextWithAnsiRanges(source, 20);
		assert.deepEqual(result.ranges, [
			{ start: 0, end: 3 },
			{ start: 4, end: 10 },
		]);
		assert.equal(source.slice(result.ranges[1]!.start, result.ranges[1]!.end), "\ttwo  ");
	});

	it("preserves the existing renderer output and maps each emitted row to its actual input", () => {
		const samples = [
			"",
			" ",
			"     ",
			"abcdef",
			"abc def",
			"abc  def   ghi   ",
			" abc  def ",
			"\n",
			"a\n",
			"\n\na",
			"\r\n",
			"\tword",
			"a\tbc\t",
			"a\u754cb\u754cc",
			"e\u0301e\u0301e\u0301",
			"\ud83d\udc69\u200d\ud83d\udcbbxyz",
			"\x1b[31mabcdef\x1b[0m",
			"\x1b[4mabc def ghi\x1b[0m",
			"a\x1b[31m  b\x1b[0m c",
			"\x1b[31m   \x1b[0m",
			"a\x1b[31m\nb\n\nc\x1b[0m",
			"abc \x1b[0mdef    ",
			"\x1b]8;;https://example.com\x07abcdef gh\x1b]8;;\x07",
			"\x1b]133;A\x07abc def",
			"\x1b_pi:c\x07abc def",
		];
		for (const source of samples) {
			for (let width = 1; width <= 20; width++) {
				const result = wrapTextWithAnsiRanges(source, width);
				const context = JSON.stringify({ source, width });
				assert.deepEqual(result.lines, wrapTextWithAnsi(source, width), context);
				assert.equal(result.lines.length, result.ranges.length, context);
				let previousEnd = 0;
				for (const [index, range] of result.ranges.entries()) {
					assert.ok(range.start >= previousEnd && range.end >= range.start && range.end <= source.length, context);
					assert.equal(
						stripTerminalSequences(source.slice(range.start, range.end)),
						stripTerminalSequences(result.lines[index]!),
						`${context} row=${index}`,
					);
					previousEnd = range.end;
				}
			}
		}
	});
});
