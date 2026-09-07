import type { SelectionMessage } from "./selection-message.ts";
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
	readonly message?: SelectionMessage;
	/** An explicitly positioned legacy row still trims selected trailing whitespace. */
	readonly legacy?: boolean;
}

export interface CopyOrder {
	readonly group: CopySource;
	readonly column: number;
	readonly occurrence?: string;
}

export interface CopySpan {
	/** Explicit logical column order within one contiguous selected group. */
	readonly readingOrder?: CopyOrder;
	/** Begin a separate copy run, including repeated sources and clipping boundaries. */
	readonly breakBefore?: boolean;
	/** Stable layout lane; distinct horizontal occurrences never share a copy run. */
	readonly flow?: string;
	/** A trailing zero-cell anchor belongs to content before it, not the next pane. */
	readonly anchorBefore?: boolean;
	/** Expanded tab cells can be clipped separately while still copying one original tab. */
	readonly splittable?: boolean;
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
const owned = new WeakSet<readonly string[]>();
const tracked = new WeakMap<readonly string[], { valid: boolean }>();
const snapshots = new WeakMap<readonly string[], { record?: SelectionRecord; lines: string[]; keys: string[] }>();

/** Transfer a final engine-owned array; do not retain a writable raw alias. Legacy rewrites remain allowed. */
export function trackSelectionLines(lines: string[]): string[] {
	const state = { valid: true };
	const changing = () => {
		// Resolve a retained snapshot before a legacy rewrite can affect its lazy factory.
		const snapshot = snapshots.get(proxy);
		if (snapshot) getSelectionMap(snapshot.lines);
		state.valid = false;
	};
	const proxy = new Proxy(lines, {
		defineProperty(target, key, descriptor) {
			changing();
			return Reflect.defineProperty(target, key, descriptor);
		},
		deleteProperty(target, key) {
			changing();
			return Reflect.deleteProperty(target, key);
		},
		setPrototypeOf(target, prototype) {
			changing();
			return Reflect.setPrototypeOf(target, prototype);
		},
	});
	tracked.set(proxy, state);
	const record = records.get(lines);
	if (record) records.set(proxy, record);
	return proxy;
}

function validatedRecord(lines: readonly string[]): SelectionRecord | undefined {
	const record = records.get(lines);
	if (!record || owned.has(lines)) return record;
	const state = tracked.get(lines);
	if (state) return state.valid ? record : undefined;
	// Unknown mutable output is validated at the composition boundary. Hot reads
	// use the owned snapshot instead, which cannot change behind its metadata.
	return lines.length === record.lines.length && record.lines.every((line, index) => line === lines[index])
		? record
		: undefined;
}

/** Bind lazy metadata to this exact render result, not to mutable component state. */
export function setSelectionMap(lines: string[], build: () => SelectionMap | undefined): void {
	records.set(lines, { lines: [...lines], build });
}

export function getSelectionMap(lines: readonly string[]): SelectionMap | undefined {
	const record = validatedRecord(lines);
	if (!record) return undefined;
	record.resolved ??= { map: record.build() };
	return record.resolved.map;
}

/** Own the painted array while retaining the metadata factory of this render, not a later one. */
export function snapshotSelectionLines(lines: readonly string[]): string[] {
	if (owned.has(lines)) return lines as string[];
	const record = validatedRecord(lines);
	const previous = snapshots.get(lines);
	if (previous && previous.record === record) {
		if (tracked.get(lines)?.valid) return previous.lines;
		const keys = previous.keys;
		if (
			previous.lines.length === lines.length &&
			(keys.length === lines.length || Object.getOwnPropertyNames(lines).length === keys.length + 1) &&
			keys.every((key) => Object.hasOwn(lines, key) && lines[Number(key)] === previous.lines[Number(key)])
		)
			return previous.lines;
	}
	const snapshot: string[] = new Array(lines.length);
	const keys: string[] = [];
	// Preserve sparse rows without expanding holes or trusting a replaced iterator.
	for (const key of Object.getOwnPropertyNames(lines)) {
		const index = Number(key);
		if (Number.isInteger(index) && index >= 0 && index < lines.length && String(index) === key) {
			snapshot[index] = lines[index]!;
			keys.push(key);
		}
	}
	if (record && (tracked.get(lines)?.valid || record.lines.every((line, index) => line === snapshot[index]))) {
		records.set(snapshot, {
			lines: snapshot,
			build: () => {
				record.resolved ??= { map: record.build() };
				return record.resolved.map;
			},
		});
	}
	Object.freeze(snapshot);
	owned.add(snapshot);
	snapshots.set(lines, { record, lines: snapshot, keys });
	return snapshot;
}

/** Keep unknown output as independent rendered rows, without inventing logical wrap metadata. */
export function legacySelectionRow(line: string): readonly CopySpan[] {
	const source = { text: stripTerminalSequences(line), legacy: true };
	const spans: CopySpan[] = [];
	let column = 0;
	for (const segment of getGraphemeSegmenter().segment(source.text)) {
		const end = column + visibleWidth(segment.segment);
		spans.push({
			columnStart: column,
			columnEnd: end,
			source,
			start: segment.index,
			end: segment.index + segment.segment.length,
		});
		column = end;
	}
	if (spans.length === 0) spans.push({ columnStart: 0, columnEnd: 0, source, start: 0, end: 0 });
	return spans;
}

export function joinSelectionMaps(lines: string[], children: readonly string[][]): void {
	if (!children.some((child) => records.has(child))) return;
	const inputs = children.map(snapshotSelectionLines);
	setSelectionMap(lines, () => {
		const rows: (readonly CopySpan[] | undefined)[] = [];
		for (const [index, child] of inputs.entries()) {
			let map: SelectionMap | undefined;
			let ready = false;
			let boundaryRow = 0;
			let firstContentRow: number | undefined;
			const resolve = (row: number): readonly CopySpan[] | undefined => {
				if (!ready) {
					map = getSelectionMap(child);
					ready = true;
				}
				if (!map) return undefined;
				const spans = map[row]?.map((span) =>
					span.readingOrder
						? {
								...span,
								readingOrder: {
									...span.readingOrder,
									occurrence: `v${index}/${span.readingOrder.occurrence ?? ""}`,
								},
							}
						: span,
				);
				if (spans?.length && !spans[0]!.breakBefore) {
					// Only inspect the boundary prefix when it is not already marked.
					while (firstContentRow === undefined && boundaryRow <= row) {
						if (map[boundaryRow]?.length) firstContentRow = boundaryRow;
						boundaryRow++;
					}
					if (firstContentRow === row) return [{ ...spans[0]!, breakBefore: true }, ...spans.slice(1)];
				}
				return spans;
			};
			// Resolving the transcript must not resolve every historical message.
			// Array accessors retain normal slice/map/iteration and readonly semantics.
			for (let row = 0; row < child.length; row++) {
				let cached: { spans: readonly CopySpan[] | undefined } | undefined;
				Object.defineProperty(rows, rows.length, {
					enumerable: true,
					configurable: true,
					get: () => {
						cached ??= { spans: resolve(row) };
						return cached.spans;
					},
				});
			}
		}
		return rows;
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
			return span.columnStart >= start && span.columnEnd <= end && (!span.anchorBefore || span.columnStart > start);
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
	const chunks: Array<{
		source?: CopySource;
		flow?: string;
		readingOrder?: CopyOrder;
		row: number;
		separator: string;
		start: number;
		end: number;
		text?: string;
	}> = [];
	const sameGroup = (a: CopyOrder | undefined, b: CopyOrder | undefined) =>
		a !== undefined && b !== undefined && a.group === b.group && a.occurrence === b.occurrence;
	const append = (span: CopySpan, row: number, boundaryRow = row) => {
		const previous = chunks[chunks.length - 1];
		if (
			!span.breakBefore &&
			previous?.source === span.source &&
			previous.flow === span.flow &&
			((!previous.readingOrder && !span.readingOrder) ||
				(sameGroup(previous.readingOrder, span.readingOrder) &&
					previous.readingOrder?.column === span.readingOrder?.column)) &&
			span.start >= previous.start
		) {
			previous.end = Math.max(previous.end, span.end);
			previous.row = row;
			previous.readingOrder = span.readingOrder;
		} else {
			const adjacentColumn =
				sameGroup(previous?.readingOrder, span.readingOrder) &&
				previous?.readingOrder?.column !== span.readingOrder?.column;
			const separator = !previous
				? ""
				: adjacentColumn || (previous.row === boundaryRow && previous.flow !== span.flow)
					? "\t"
					: "\n";
			chunks.push({
				source: span.source,
				flow: span.flow,
				readingOrder: span.readingOrder,
				row,
				separator,
				start: span.start,
				end: span.end,
			});
		}
	};
	let pending: Array<{ span: CopySpan; row: number }> = [];
	const interrupted = new Map<CopySource, Set<string | undefined>>();
	const flush = () => {
		if (pending.length === 0) return;
		const firstScreenRow = pending[0]!.row;
		const lastScreenRow = pending[pending.length - 1]!.row;
		// Sort only selected fragments, and never across an unrelated component or legacy row.
		pending.sort((a, b) => a.span.readingOrder!.column - b.span.readingOrder!.column);
		for (const [index, { span, row }] of pending.entries()) append(span, row, index === 0 ? firstScreenRow : row);
		// A short last column must not change the boundary to neighbouring screen content.
		chunks[chunks.length - 1]!.row = lastScreenRow;
		pending = [];
	};
	for (let row = firstRow; row <= lastRow; row++) {
		const line = lines[row] ?? "";
		const range = columns(line, row);
		const spans = map?.[row];
		if (spans === undefined) {
			flush();
			chunks.push({
				row,
				separator: chunks.length ? "\n" : "",
				start: 0,
				end: 0,
				text: stripTerminalSequences(
					sliceByColumn(line, range.start, Math.max(0, range.end - range.start), true),
				).trimEnd(),
			});
			continue;
		}
		const selected = new Set(selectedCopySpans(spans, range.start, range.end, 0, maxColumn));
		for (const original of spans) {
			if (!selected.has(original)) {
				if (original.readingOrder) {
					let flows = interrupted.get(original.source);
					if (!flows) {
						flows = new Set();
						interrupted.set(original.source, flows);
					}
					flows.add(original.flow);
				}
				continue;
			}
			const skipped = original.readingOrder && interrupted.get(original.source)?.delete(original.flow);
			const span = skipped ? { ...original, breakBefore: true } : original;
			if (pending.length && !sameGroup(pending[0]!.span.readingOrder, span.readingOrder)) flush();
			if (span.readingOrder) pending.push({ span, row });
			else append(span, row);
		}
	}
	flush();
	const parts = chunks.map((chunk) => {
		const text = chunk.source ? chunk.source.text.slice(chunk.start, chunk.end) : chunk.text!;
		return { ...chunk, text: chunk.source?.legacy ? text.trimEnd() : text };
	});
	const messages = new Set(parts.filter((part) => part.text.length > 0).map((part) => part.source?.message));
	messages.delete(undefined);
	let previousMessage: SelectionMessage | undefined;
	let text = "";
	for (const part of parts) {
		const message = part.source?.message;
		if (messages.size > 1 && message && !messages.has(message)) continue;
		if (messages.size > 1 && message !== previousMessage) {
			text += (text.length ? "\n\n" : "") + (message ? `${message.label}\n\n` : "") + part.text;
		} else text += part.separator + part.text;
		previousMessage = message;
	}
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
				spans.push({
					columnStart: column,
					columnEnd: column + cells,
					source,
					start,
					end,
					splittable: source.text[start] === "\t",
				});
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
				anchorBefore: spans.length > 0,
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
