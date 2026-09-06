import type { LayoutRect } from "./layout.ts";
import {
	type CopySource,
	type CopySpan,
	getSelectionMap,
	legacySelectionRow,
	setSelectionMap,
	snapshotSelectionLines,
} from "./selection-map.ts";
import { stripTerminalSequences, visibleWidth } from "./utils.ts";

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
				const spans = map?.[row] ?? legacySelectionRow(childLine);
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

export interface SelectionProjectionPart extends VerticalSelectionPart {
	readonly clip: LayoutRect;
	readonly flow: string;
	readonly sourceRow?: number;
}

/** Project whole graphemes, retaining discontinuities so clipping cannot restore hidden source gaps. */
export function projectSelectionPart(rows: CopySpan[][], part: SelectionProjectionPart): void {
	const left = Math.max(0, part.column, part.clip.x);
	const right = Math.min(part.column + part.width, part.clip.x + part.clip.width);
	const first = Math.max(0, part.row, part.clip.y);
	const end = Math.min(rows.length, part.row + (part.height ?? part.lines.length), part.clip.y + part.clip.height);
	if (left >= right || first >= end) return;
	const map = getSelectionMap(part.lines);
	const interrupted = new Map<CopySource, Set<string | undefined>>();
	let firstContent = true;
	for (let row = first; row < end; row++) {
		const sourceRow = (part.sourceRow ?? 0) + row - part.row;
		const line = part.lines[sourceRow];
		if (line === undefined) continue;
		for (const span of map?.[sourceRow] ?? legacySelectionRow(line)) {
			const columnStart = part.column + span.columnStart;
			const columnEnd = part.column + span.columnEnd;
			const partialCells = span.splittable && columnEnd > left && columnStart < right;
			const outsideAnchor = columnStart === columnEnd && columnStart === right && !span.anchorBefore;
			if (((columnStart < left || columnEnd > right) && !partialCells) || outsideAnchor) {
				let flows = interrupted.get(span.source);
				if (!flows) {
					flows = new Set();
					interrupted.set(span.source, flows);
				}
				flows.add(span.flow);
				continue;
			}
			const clippedBefore = interrupted.get(span.source)?.delete(span.flow) ?? false;
			rows[row]!.push({
				...span,
				columnStart: Math.max(left, columnStart),
				columnEnd: Math.min(right, columnEnd),
				flow: `${part.flow}/${span.flow ?? ""}`,
				breakBefore: firstContent || clippedBefore || span.breakBefore,
			});
			firstContent = false;
		}
	}
}

/** Horizontal render facades own only their child cells; gaps and alignment padding are decoration. */
export function composeHorizontalSelection(
	lines: string[],
	parts: readonly VerticalSelectionPart[],
	width: number,
): void {
	const snapshots = parts.map((part) => ({ ...part, lines: snapshotSelectionLines(part.lines) }));
	setSelectionMap(lines, () => {
		const rows: CopySpan[][] = Array.from({ length: lines.length }, () => []);
		for (const [index, part] of snapshots.entries()) {
			projectSelectionPart(rows, {
				...part,
				flow: String(index),
				clip: { x: 0, y: 0, width, height: lines.length },
			});
		}
		for (const row of rows) row.sort((a, b) => a.columnStart - b.columnStart);
		return rows;
	});
}
