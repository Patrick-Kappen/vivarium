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
import { type CopySourceCache, deferCopySource } from "./selection-source.ts";
import { reflowSelectionSpans } from "./selection-wrap.ts";
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
	readonly sources: CopySourceCache[] = [];
	private readonly previous: readonly CopySourceCache[];
	private readonly rows = new WeakMap<string[], Map<number, (() => MarkdownLineSource | undefined) | null>>();
	private readonly codeRows = new WeakMap<string[], () => ReadonlyMap<number, MarkdownLineSource>>();

	constructor(previous: readonly CopySourceCache[]) {
		this.previous = previous;
	}

	private source(text: () => string): () => CopySource {
		const cache = this.previous[this.sources.length] ?? {};
		this.sources.push(cache);
		return deferCopySource(cache, text);
	}

	private set(lines: string[], row: number, source: (() => MarkdownLineSource | undefined) | null): void {
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
		const painted = lines[row]!;
		const source = this.source(() =>
			original === undefined
				? stripTerminalSequences(painted).slice(prefix.length)
				: stripTerminalSequences(original),
		);
		this.set(lines, row, () => {
			const plain = stripTerminalSequences(painted);
			if (!plain.startsWith(prefix)) return undefined;
			const content = plain.slice(prefix.length);
			const copySource = source();
			const normalization = copySource.text !== content ? new MarkdownSource(copySource.text) : undefined;
			if (normalization && normalization.text !== content) return undefined;
			return { source: copySource, prefix, offset: 0, normalization };
		});
	}

	code(lines: string[], code: string, prefix: string, original: string | null = code): void {
		this.decoration(lines, 0);
		this.decoration(lines, lines.length - 1);
		if (original === null) return;
		const painted = [...lines];
		const source = this.source(() => stripTerminalSequences(original));
		let resolved: Map<number, MarkdownLineSource> | undefined;
		this.codeRows.set(lines, () => {
			if (resolved) return resolved;
			resolved = new Map();
			const plain = stripTerminalSequences(code);
			const copySource = source();
			const normalization = copySource.text !== plain ? new MarkdownSource(copySource.text) : undefined;
			if (normalization && normalization.text !== plain) return resolved;
			const plainPrefix = stripTerminalSequences(prefix);
			const codeLines = plain.split("\n");
			if (painted.length !== codeLines.length + 2 || prefix.includes("\t")) return resolved;
			for (const [index, line] of codeLines.entries()) {
				// Validate the original highlighter output only on selection. Do not
				// rerun callbacks or inherit hidden text from a rewriting highlighter.
				if (stripTerminalSequences(painted[index + 1]!) !== plainPrefix + line) return resolved;
			}
			let offset = 0;
			for (const [index, line] of codeLines.entries()) {
				resolved.set(index + 1, { source: copySource, prefix: plainPrefix, offset, normalization });
				offset += line.length + 1;
			}
			return resolved;
		});
	}

	decoratePrefix(result: string[], content: string[], prefixes: readonly string[], semanticFirstPrefix = false): void {
		const height = result.length;
		const markerText = prefixes[0] ?? "";
		const markerSource = semanticFirstPrefix ? this.source(() => stripTerminalSequences(markerText)) : undefined;
		setSelectionMap(result, () => {
			const marker = markerSource?.();
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
			const descriptorSource = this.rows.get(block)?.get(index);
			const codeSource = this.codeRows.get(block);
			builders.push(() => {
				const descriptor = descriptorSource === null ? null : (descriptorSource?.() ?? codeSource?.().get(index));
				if (descriptor === null) return wrapped.lines.map(() => []);
				if (line.includes("\t") || stripTerminalSequences(line) !== stripTerminalSequences(original))
					return wrapped.lines.map(() => undefined);
				if (!descriptor) {
					// Nested output is already mapped; reflow its cells without creating a
					// new source from the quote-prefixed text. Validate each block only once.
					if (!inheritedMaps.has(block)) inheritedMaps.set(block, getSelectionMap(block));
					const spans = inheritedMaps.get(block)?.[index];
					return spans ? reflowSelectionSpans(line, wrapped.ranges, spans) : wrapped.ranges.map(() => undefined);
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
