import {
	extractAnsiCode,
	getGraphemeSegmenter,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
	type WrappedSourceRange,
} from "./utils.ts";

// Internal prototype, deliberately not exported from the package entrypoint.
export interface CopySource {
	readonly text: string;
	/** An explicitly positioned legacy row still trims selected trailing whitespace. */
	readonly legacy?: boolean;
}

export interface CopySpan {
	/** Begin a separate vertical copy block, even when a cached source is reused. */
	readonly breakBefore?: boolean;
	readonly columnStart: number;
	readonly columnEnd: number;
	readonly source: CopySource;
	readonly start: number;
	readonly end: number;
}

/** Undefined rows use legacy copying; an empty array explicitly means decoration. */
export type SelectionMap = readonly (readonly CopySpan[] | undefined)[];

interface SelectionRecord {
	lines: readonly string[];
	build: () => SelectionMap | undefined;
	resolved?: { map: SelectionMap | undefined };
}

const records = new WeakMap<readonly string[], SelectionRecord>();

/** Bind lazy metadata to this exact render result, not to mutable component state. */
export function setSelectionMap(lines: string[], build: () => SelectionMap | undefined): void {
	records.set(lines, { lines: [...lines], build });
}

export function getSelectionMap(lines: readonly string[]): SelectionMap | undefined {
	const record = records.get(lines);
	if (!record) return undefined;
	// Legacy wrappers may mutate a child's output instead of returning a new array.
	if (lines.length !== record.lines.length || lines.some((line, index) => line !== record.lines[index]))
		return undefined;
	record.resolved ??= { map: record.build() };
	return record.resolved.map;
}

export function joinSelectionMaps(lines: string[], children: readonly string[][]): void {
	if (!children.some((child) => records.has(child))) return;
	setSelectionMap(lines, () => {
		const rows: (readonly CopySpan[] | undefined)[] = [];
		let mapped = false;
		for (const child of children) {
			const map = getSelectionMap(child);
			mapped ||= map !== undefined;
			let firstContent = true;
			for (let row = 0; row < child.length; row++) {
				const spans = map?.[row];
				if (firstContent && spans?.length) {
					rows.push([{ ...spans[0]!, breakBefore: true }, ...spans.slice(1)]);
					firstContent = false;
				} else rows.push(spans);
			}
		}
		return mapped ? rows : undefined;
	});
}

export function selectedCopySpans(
	spans: readonly CopySpan[],
	start: number,
	end: number,
	minColumn = 0,
	maxColumn = Number.POSITIVE_INFINITY,
): readonly CopySpan[] {
	if (end <= start) return [];
	return spans.filter((span) => {
		if (span.columnStart < minColumn || span.columnEnd > maxColumn) return false;
		if (span.columnStart === span.columnEnd) {
			return span.columnStart >= start && span.columnEnd <= end;
		}
		return span.columnStart < end && span.columnEnd > start;
	});
}

export function selectionText(
	lines: readonly string[],
	map: SelectionMap | undefined,
	firstRow: number,
	lastRow: number,
	columns: (line: string, row: number) => { start: number; end: number },
	maxColumn: number,
): string | undefined {
	const chunks: Array<{ source?: CopySource; start: number; end: number; text?: string }> = [];
	for (let row = firstRow; row <= lastRow; row++) {
		const line = lines[row] ?? "";
		const range = columns(line, row);
		const spans = map?.[row];
		if (spans === undefined) {
			chunks.push({
				start: 0,
				end: 0,
				text: stripTerminalSequences(
					sliceByColumn(line, range.start, Math.max(0, range.end - range.start), true),
				).trimEnd(),
			});
			continue;
		}
		for (const span of selectedCopySpans(spans, range.start, range.end, 0, maxColumn)) {
			const previous = chunks[chunks.length - 1];
			if (!span.breakBefore && previous?.source === span.source && span.start >= previous.start) {
				previous.end = Math.max(previous.end, span.end);
			} else {
				chunks.push({ source: span.source, start: span.start, end: span.end });
			}
		}
	}
	const text = chunks
		.map((chunk) => {
			const text = chunk.source ? chunk.source.text.slice(chunk.start, chunk.end) : chunk.text!;
			return chunk.source?.legacy ? text.trimEnd() : text;
		})
		.join("\n");
	return text.length ? text : undefined;
}

/** Build cell/source correspondence from recorded wrap ranges, never by matching rendered strings. */
export function textSelectionMap(
	text: string,
	normalized: string,
	ranges: readonly WrappedSourceRange[],
	paddingX: number,
	paddingY: number,
	contentWidth: number,
	source: CopySource,
): SelectionMap | undefined {
	const starts: number[] = [];
	const ends: number[] = [];
	let plain = "";
	for (let index = 0; index < text.length; ) {
		const ansi = extractAnsiCode(text, index);
		if (ansi) {
			const length = ansi.code.replace(/\t/g, "   ").length;
			for (let unit = 0; unit < length; unit++) {
				starts.push(plain.length);
				ends.push(plain.length);
			}
			index += ansi.length;
			continue;
		}
		const char = text[index++]!;
		const start = plain.length;
		plain += char;
		for (let unit = 0; unit < (char === "\t" ? 3 : 1); unit++) {
			starts.push(start);
			ends.push(plain.length);
		}
	}
	const logicalEnds = [...normalized.matchAll(/\r\n|\r|\n/g)].map((match) => match.index);
	logicalEnds.push(normalized.length);
	let logicalLine = 0;
	const rows: CopySpan[][] = Array.from({ length: paddingY }, () => []);
	for (const [row, range] of ranges.entries()) {
		while (logicalEnds[logicalLine]! < range.start) logicalLine++;
		let visible = "";
		const offsets: number[] = [];
		for (let index = range.start; index < range.end; ) {
			const ansi = extractAnsiCode(normalized, index);
			if (ansi) {
				index += ansi.length;
				continue;
			}
			offsets.push(index);
			visible += normalized[index++]!;
		}
		const spans: CopySpan[] = [];
		let column = paddingX;
		for (const segment of getGraphemeSegmenter().segment(visible)) {
			const cells = visibleWidth(segment.segment);
			const start = starts[offsets[segment.index]!]!;
			const end = ends[offsets[segment.index + segment.segment.length - 1]!]!;
			const previous = spans[spans.length - 1];
			if (previous && previous.start === start && previous.end === end && previous.columnEnd === column) {
				spans[spans.length - 1] = { ...previous, columnEnd: column + cells };
			} else {
				spans.push({ columnStart: column, columnEnd: column + cells, source, start, end });
			}
			column += cells;
		}
		// A glyph wider than the available viewport is not wholly visible. Keep legacy
		// selection for this result until clipped-source composition is supported.
		if (column > paddingX + contentWidth) return undefined;
		const end = starts[range.end] ?? plain.length;
		const next = ranges[row + 1];
		const logicalEnd =
			!next || next.start > logicalEnds[logicalLine]! ? (starts[logicalEnds[logicalLine]!] ?? plain.length) : end;
		// Zero-cell anchors distinguish real blank lines and stripped source tails from padding.
		if (spans.length === 0 || logicalEnd > end) {
			spans.push({
				columnStart: column,
				columnEnd: column,
				source,
				start: spans.length ? end : (starts[range.start] ?? plain.length),
				end: logicalEnd,
			});
		}
		rows.push(spans);
	}
	for (let row = 0; row < paddingY; row++) rows.push([]);
	return rows;
}
