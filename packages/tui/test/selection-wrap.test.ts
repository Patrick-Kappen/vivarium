import assert from "node:assert/strict";
import { it } from "node:test";
import { type CopySpan, legacySelectionRow } from "../src/selection-map.ts";
import { reflowSelectionSpans } from "../src/selection-wrap.ts";
import { visibleWidth, wrapTextWithAnsiRanges } from "../src/utils.ts";

// PR #17: preserve the previous clipping/anchor semantics while eliminating prefix rescans.
it("matches the reference reflow across styling, Unicode, gaps and unordered spans", () => {
	const texts = [
		"",
		"abc",
		"  abc def   ",
		"a\nb\n",
		"a\r\nb",
		"a\tbc",
		"\u754c e\u0301 \ud83d\udc69\u200d\ud83d\udcbb xyz",
		"\x1b[31mab\x1b[0m cd ef",
		"\x1b]8;;https://example.test\x07ab cd\x1b]8;;\x07",
	];
	for (const line of texts) {
		for (let width = 1; width <= 12; width++) {
			const { ranges } = wrapTextWithAnsiRanges(line, width);
			const source = { text: line };
			const spans: CopySpan[] = [...legacySelectionRow(line)];
			for (let column = 0; column <= visibleWidth(line) + 2; column++) {
				for (const anchorBefore of [true, false])
					spans.push({ source, start: 0, end: 0, columnStart: column, columnEnd: column, anchorBefore });
			}
			spans.reverse();
			const expected = ranges.map((range, fragment) => {
				const start = visibleWidth(line.slice(0, range.start));
				const end = visibleWidth(line.slice(0, range.end));
				const last = fragment === ranges.length - 1;
				const next = visibleWidth(line.slice(0, ranges[fragment + 1]?.start ?? line.length));
				return spans.flatMap((span) => {
					if (span.columnStart === span.columnEnd) {
						const anchor = last ? Math.min(span.columnStart, end) : span.columnStart;
						if (anchor < start || anchor > end || (fragment > 0 && anchor === start && span.anchorBefore))
							return [];
						return [{ ...span, columnStart: anchor - start, columnEnd: anchor - start }];
					}
					if (span.columnStart >= end && span.columnEnd <= next)
						return [{ ...span, columnStart: end - start, columnEnd: end - start, anchorBefore: end > start }];
					if (span.columnStart < start || span.columnEnd > end) return [];
					return [{ ...span, columnStart: span.columnStart - start, columnEnd: span.columnEnd - start }];
				});
			});
			assert.deepEqual(reflowSelectionSpans(line, ranges, spans), expected, `${JSON.stringify(line)} @ ${width}`);
		}
	}
});
