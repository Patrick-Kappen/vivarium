import { MarkdownSource } from "./markdown-source.ts";
import {
	type CopySource,
	type CopySpan,
	getSelectionMap,
	legacySelectionRow,
	type SelectionMap,
	setSelectionMap,
	textSelectionMap,
} from "./selection-map.ts";
import { isImageLine } from "./terminal-image.ts";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsiRanges } from "./utils.ts";

interface MarkdownLineSource {
	source: CopySource;
	prefix: string;
	offset: number;
	normalization?: MarkdownSource;
}

// One live composition per source bounds cache growth while retaining identity on ordinary rerenders.
const prefixedSources = new WeakMap<CopySource, { prefix: string; start: number; source: CopySource }>();

/** Metadata recorded at Markdown emission sites, before visual wrapping or margins. */
export class MarkdownSelection {
	readonly sources: CopySource[] = [];
	private readonly previous: readonly CopySource[];
	private readonly rows = new WeakMap<string[], Map<number, MarkdownLineSource | null>>();

	constructor(previous: readonly CopySource[]) {
		this.previous = previous;
	}

	private source(text: string): CopySource {
		const old = this.previous[this.sources.length];
		const source = old?.text === text ? old : { text };
		this.sources.push(source);
		return source;
	}

	private set(lines: string[], row: number, source: MarkdownLineSource | null): void {
		let rows = this.rows.get(lines);
		if (!rows) {
			rows = new Map();
			this.rows.set(lines, rows);
		}
		rows.set(row, source);
	}

	decoration(lines: string[], row: number): void {
		this.set(lines, row, null);
	}

	text(lines: string[], row: number, prefix = "", original?: string): void {
		const plain = stripTerminalSequences(lines[row]!);
		if (!plain.startsWith(prefix)) return;
		const content = plain.slice(prefix.length);
		const originalPlain = original === undefined ? content : stripTerminalSequences(original);
		const normalization = originalPlain !== content ? new MarkdownSource(originalPlain) : undefined;
		if (normalization && normalization.text !== content) return;
		this.set(lines, row, { source: this.source(originalPlain), prefix, offset: 0, normalization });
	}

	code(lines: string[], code: string, prefix: string, original: string | null = code): void {
		this.decoration(lines, 0);
		this.decoration(lines, lines.length - 1);
		if (original === null) return;
		const plain = stripTerminalSequences(code);
		const originalPlain = stripTerminalSequences(original);
		const normalization = originalPlain !== plain ? new MarkdownSource(originalPlain) : undefined;
		if (normalization && normalization.text !== plain) return;
		const source = this.source(originalPlain);
		const plainPrefix = stripTerminalSequences(prefix);
		const codeLines = plain.split("\n");
		if (lines.length !== codeLines.length + 2 || prefix.includes("\t")) return;
		for (const [index, line] of codeLines.entries()) {
			// Highlighters may rewrite or reorder text. Only styling-only output can
			// inherit the code source; unknown rows retain their rendered fallback.
			if (stripTerminalSequences(lines[index + 1]!) !== plainPrefix + line) return;
		}
		let offset = 0;
		for (const [index, line] of codeLines.entries()) {
			this.set(lines, index + 1, { source, prefix: plainPrefix, offset, normalization });
			offset += line.length + 1;
		}
	}

	decoratePrefix(result: string[], content: string[], prefixes: readonly string[], semanticFirstPrefix = false): void {
		const height = result.length;
		const marker = semanticFirstPrefix ? this.source(stripTerminalSequences(prefixes[0] ?? "")) : undefined;
		setSelectionMap(result, () => {
			const map = getSelectionMap(content);
			const rows = content.map((line, row) => map?.[row] ?? legacySelectionRow(line));
			const first = marker ? rows.find((row) => row.length > 0)?.[0] : undefined;
			let source = marker;
			if (marker && first) {
				const previous = prefixedSources.get(first.source);
				if (previous?.prefix === marker.text && previous.start === first.start) source = previous.source;
				else {
					// Start at the first mapped offset: a marker must not resurrect hidden leading content.
					source = { text: marker.text + first.source.text.slice(first.start), legacy: first.source.legacy };
					prefixedSources.set(first.source, { prefix: marker.text, start: first.start, source });
				}
			}
			let joined = false;
			return Array.from({ length: height }, (_, row) => {
				if (row >= content.length) return [];
				const prefix = prefixes[row]!;
				if (prefix.includes("\t")) return undefined;
				const offset = visibleWidth(prefix);
				const spans = rows[row]!.map((span) => {
					const placed = { ...span, columnStart: span.columnStart + offset, columnEnd: span.columnEnd + offset };
					if (!source || !marker || !first || span.source !== first.source || span.flow !== first.flow)
						return placed;
					const breakBefore = joined ? span.breakBefore : false;
					joined = true;
					return {
						...placed,
						source,
						breakBefore,
						start: span.start - first.start + marker.text.length,
						end: span.end - first.start + marker.text.length,
					};
				});
				if (row === 0 && source) {
					return [
						...legacySelectionRow(prefix).map((span) => ({
							...span,
							source,
							flow: first?.flow,
							readingOrder: first?.readingOrder,
						})),
						...spans,
					];
				}
				return spans;
			});
		});
	}

	wrap(
		blocks: readonly string[][],
		width: number,
		options: {
			style?: (line: string) => string;
			trimEmptyEnd?: boolean;
			onWrappedLine?: () => void;
			wrapImages?: boolean;
		} = {},
	): string[] {
		const result: string[] = [];
		const builders: Array<() => readonly (readonly CopySpan[] | undefined)[]> = [];
		const inheritedMaps = new Map<string[], SelectionMap | undefined>();
		const inputs = blocks.flatMap((block) => block.map((original, index) => ({ block, original, index })));
		if (options.trimEmptyEnd) while (inputs.at(-1)?.original === "") inputs.pop();
		for (const { block, original, index } of inputs) {
			const line = options.style ? options.style(original) : original;
			if (isImageLine(line) && !options.style && !options.wrapImages) {
				result.push(line);
				builders.push(() => [undefined]);
				continue;
			}
			const wrapped = wrapTextWithAnsiRanges(line, width);
			for (const wrappedLine of wrapped.lines) {
				options.onWrappedLine?.();
				result.push(wrappedLine);
			}
			const descriptor = this.rows.get(block)?.get(index);
			builders.push(() => {
				if (descriptor === null) return wrapped.lines.map(() => []);
				if (line.includes("\t") || stripTerminalSequences(line) !== stripTerminalSequences(original))
					return wrapped.lines.map(() => undefined);
				if (!descriptor) {
					// Nested output is already mapped; reflow its cells without creating a
					// new source from the quote-prefixed text. Validate each block only once.
					if (!inheritedMaps.has(block)) inheritedMaps.set(block, getSelectionMap(block));
					const spans = inheritedMaps.get(block)?.[index];
					return wrapped.ranges.map((range, fragment) => {
						const start = visibleWidth(line.slice(0, range.start));
						const end = visibleWidth(line.slice(0, range.end));
						const last = fragment === wrapped.ranges.length - 1;
						const next = visibleWidth(line.slice(0, wrapped.ranges[fragment + 1]?.start ?? line.length));
						return spans?.flatMap((span) => {
							if (span.columnStart === span.columnEnd) {
								const anchor = last ? Math.min(span.columnStart, end) : span.columnStart;
								if (anchor < start || anchor > end || (fragment > 0 && anchor === start && span.anchorBefore))
									return [];
								return [{ ...span, columnStart: anchor - start, columnEnd: anchor - start }];
							}
							// Recorded wrap gaps contain omitted whitespace. Keep only spans already
							// declared as content, not unmarked continuation or quote padding.
							if (span.columnStart >= end && span.columnEnd <= next) {
								return [
									{ ...span, columnStart: end - start, columnEnd: end - start, anchorBefore: end > start },
								];
							}
							if (span.columnStart < start || span.columnEnd > end) return [];
							return [{ ...span, columnStart: span.columnStart - start, columnEnd: span.columnEnd - start }];
						});
					});
				}
				const plain = stripTerminalSequences(line);
				const map = textSelectionMap(line, line, wrapped.ranges, 0, 0, width, { text: plain });
				return wrapped.lines.map((_, row) => {
					const spans = map?.[row];
					const prefix = descriptor.prefix.length;
					if (
						spans?.some((span) => span.start < prefix && span.end > prefix && span.columnStart !== span.columnEnd)
					)
						return undefined;
					return spans?.flatMap((originalSpan) => {
						let span = originalSpan;
						const next = wrapped.ranges[row + 1];
						const range = wrapped.ranges[row]!;
						// A prefix-only empty wrap can precede omitted content whitespace.
						// Keep that declared gap before filtering the decorative prefix.
						if (
							next &&
							span.columnStart === span.columnEnd &&
							span.start === span.end &&
							!/[\r\n]/.test(line.slice(range.end, next.start))
						) {
							span = {
								...span,
								end: Math.max(span.end, stripTerminalSequences(line.slice(0, next.start)).length),
							};
						}
						if (span.start < prefix && (span.columnStart !== span.columnEnd || span.end < prefix)) return [];
						const start = Math.max(prefix, span.start) - prefix + descriptor.offset;
						const end = span.end - prefix + descriptor.offset;
						const sourceRange = descriptor.normalization?.range(start, end) ?? { start, end };
						return [
							{
								...span,
								source: descriptor.source,
								...sourceRange,
								splittable: descriptor.source.text[sourceRange.start] === "\t",
							},
						];
					});
				});
			});
		}
		setSelectionMap(result, () => builders.flatMap((build) => build()));
		return result;
	}
}
