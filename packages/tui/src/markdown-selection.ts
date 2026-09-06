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
}

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

	text(lines: string[], row: number, prefix = ""): void {
		const plain = stripTerminalSequences(lines[row]!);
		if (!plain.startsWith(prefix)) return;
		this.set(lines, row, { source: this.source(plain.slice(prefix.length)), prefix, offset: 0 });
	}

	code(lines: string[], code: string, prefix: string): void {
		this.decoration(lines, 0);
		this.decoration(lines, lines.length - 1);
		const plain = stripTerminalSequences(code);
		const source = this.source(plain);
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
			this.set(lines, index + 1, { source, prefix: plainPrefix, offset });
			offset += line.length + 1;
		}
	}

	decoratePrefix(result: string[], content: string[], prefixes: readonly string[]): void {
		const height = result.length;
		setSelectionMap(result, () => {
			const map = getSelectionMap(content);
			return Array.from({ length: height }, (_, row) => {
				if (row >= content.length) return [];
				const prefix = prefixes[row]!;
				if (prefix.includes("\t")) return undefined;
				const offset = visibleWidth(prefix);
				return (map?.[row] ?? legacySelectionRow(content[row]!)).map((span) => ({
					...span,
					columnStart: span.columnStart + offset,
					columnEnd: span.columnEnd + offset,
				}));
			});
		});
	}

	wrap(
		blocks: readonly string[][],
		width: number,
		options: { style?: (line: string) => string; trimEmptyEnd?: boolean; onWrappedLine?: () => void } = {},
	): string[] {
		const result: string[] = [];
		const builders: Array<() => readonly (readonly CopySpan[] | undefined)[]> = [];
		const inheritedMaps = new Map<string[], SelectionMap | undefined>();
		const inputs = blocks.flatMap((block) => block.map((original, index) => ({ block, original, index })));
		if (options.trimEmptyEnd) while (inputs.at(-1)?.original === "") inputs.pop();
		for (const { block, original, index } of inputs) {
			const line = options.style ? options.style(original) : original;
			if (isImageLine(line) && !options.style) {
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
						return spans?.flatMap((span) => {
							if (span.columnStart === span.columnEnd) {
								const anchor = last ? Math.min(span.columnStart, end) : span.columnStart;
								if (anchor < start || anchor > end || (fragment > 0 && anchor === start && span.anchorBefore))
									return [];
								return [{ ...span, columnStart: anchor - start, columnEnd: anchor - start }];
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
					return spans?.flatMap((span) => {
						if (span.start < prefix && (span.columnStart !== span.columnEnd || span.end < prefix)) return [];
						return [
							{
								...span,
								source: descriptor.source,
								start: Math.max(prefix, span.start) - prefix + descriptor.offset,
								end: span.end - prefix + descriptor.offset,
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
