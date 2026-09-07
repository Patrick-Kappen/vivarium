import type { CopySpan } from "./selection-map.ts";
import { visibleWidth, type WrappedSourceRange } from "./utils.ts";

/** Reflow declared cells without rescanning the line or every span for each fragment. */
export function reflowSelectionSpans(
	line: string,
	ranges: readonly WrappedSourceRange[],
	spans: readonly CopySpan[],
): readonly CopySpan[][] {
	let offset = 0;
	let column = 0;
	const boundary = (end: number) => {
		column += visibleWidth(line.slice(offset, end));
		offset = end;
		return column;
	};
	const fragments = ranges.map((range) => ({ start: boundary(range.start), end: boundary(range.end) }));
	const lineEnd = boundary(line.length);
	const rows: CopySpan[][] = fragments.map(() => []);
	for (const span of spans) {
		let low = 0;
		let high = fragments.length;
		// Include the preceding fragment when a span lies in a declared wrap gap.
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			const next = fragments[middle + 1]?.start ?? lineEnd;
			if (next < span.columnStart) low = middle + 1;
			else high = middle;
		}
		for (let index = Math.min(low, fragments.length - 1); index >= 0 && index < fragments.length; index++) {
			const { start, end } = fragments[index]!;
			const last = index === fragments.length - 1;
			const anchorSpan = span.columnStart === span.columnEnd;
			if (start > span.columnStart && !(last && anchorSpan)) break;
			if (anchorSpan) {
				const anchor = last ? Math.min(span.columnStart, end) : span.columnStart;
				if (anchor < start || anchor > end || (index > 0 && anchor === start && span.anchorBefore)) continue;
				rows[index]!.push({ ...span, columnStart: anchor - start, columnEnd: anchor - start });
				continue;
			}
			const next = fragments[index + 1]?.start ?? lineEnd;
			// Only declared content whitespace can survive as a zero-cell wrap-gap anchor.
			if (span.columnStart >= end && span.columnEnd <= next) {
				rows[index]!.push({ ...span, columnStart: end - start, columnEnd: end - start, anchorBefore: end > start });
			} else if (span.columnStart >= start && span.columnEnd <= end) {
				rows[index]!.push({ ...span, columnStart: span.columnStart - start, columnEnd: span.columnEnd - start });
			}
		}
	}
	return rows;
}
