import { type CopySpan, getSelectionMap, setSelectionMap } from "./selection-map.ts";
import { getGraphemeSegmenter, stripTerminalSequences, visibleWidth } from "./utils.ts";

export interface VerticalSelectionPart {
	readonly lines: readonly string[];
	readonly row: number;
	readonly column: number;
	readonly width: number;
	readonly height?: number;
}

/** Compose non-overlapping vertical children; all unoccupied cells are layout decoration. */
export function composeVerticalSelection(lines: string[], parts: readonly VerticalSelectionPart[]): void {
	setSelectionMap(lines, () => {
		const rows: CopySpan[][] = Array.from({ length: lines.length }, () => []);
		for (const part of parts) {
			const map = getSelectionMap(part.lines);
			let firstContent = true;
			const height = Math.min(part.lines.length, part.height ?? part.lines.length, lines.length - part.row);
			for (let row = 0; row < height; row++) {
				const childLine = part.lines[row]!;
				const plain = stripTerminalSequences(childLine);
				// Validate geometry/styling, not source reconstruction. A background callback
				// that rewrites content cannot inherit the child's source map.
				if (
					visibleWidth(childLine) > part.width ||
					stripTerminalSequences(lines[part.row + row]!).trimEnd() !== (" ".repeat(part.column) + plain).trimEnd()
				) {
					return undefined;
				}
				let spans = map?.[row];
				if (spans === undefined) {
					// Keep unmapped rows independent and preserve their trim-on-copy behavior.
					const source = { text: plain, legacy: true };
					const legacy: CopySpan[] = [];
					let column = 0;
					for (const segment of getGraphemeSegmenter().segment(plain)) {
						const end = column + visibleWidth(segment.segment);
						legacy.push({
							columnStart: column,
							columnEnd: end,
							source,
							start: segment.index,
							end: segment.index + segment.segment.length,
						});
						column = end;
					}
					if (legacy.length === 0) legacy.push({ columnStart: 0, columnEnd: 0, source, start: 0, end: 0 });
					spans = legacy;
				}
				for (const span of spans) {
					if (span.columnStart < 0 || span.columnEnd > part.width) return undefined;
					rows[part.row + row]!.push({
						...span,
						columnStart: span.columnStart + part.column,
						columnEnd: span.columnEnd + part.column,
						breakBefore: firstContent || span.breakBefore,
					});
					firstContent = false;
				}
			}
		}
		return rows;
	});
}
