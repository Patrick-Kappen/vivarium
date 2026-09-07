import { getScrollbarGeometry, type LayoutBox, type LayoutFrame } from "./layout.ts";
import { getLayoutNode } from "./layout-node.ts";
import { projectSelectionPart } from "./selection-compose.ts";
import { type CopySpan, getSelectionMap, type SelectionMap, snapshotSelectionLines } from "./selection-map.ts";

/** Project the layout's painted leaves; allocated padding and scrollbar cells have no source. */
export function getViewportSelectionMap(frame: LayoutFrame): SelectionMap | undefined {
	const rows: CopySpan[][] = Array.from({ length: frame.height }, () => []);
	let mapped = false;
	const visit = (box: LayoutBox, flow: string, parentRight: number): void => {
		if (box.clip.width <= 0 || box.clip.height <= 0) return;
		const node = getLayoutNode(box.component);
		mapped ||= node?.type === "vstack" || node?.type === "hstack";
		const left = Math.max(0, box.clip.x);
		const right = Math.min(
			parentRight,
			box.clip.x + box.clip.width,
			getScrollbarGeometry(box)?.column ?? parentRight,
		);
		if (box.lines) {
			mapped ||= getSelectionMap(box.lines) !== undefined;
			projectSelectionPart(rows, {
				lines: box.lines,
				row: box.rect.y,
				column: box.rect.x,
				width: box.rect.width,
				height: box.rect.height,
				sourceRow: box.lineOffset,
				clip: { ...box.clip, x: left, width: Math.max(0, right - left) },
				flow,
			});
		}
		for (const [index, child] of box.children.entries()) visit(child, `${flow}/${index}`, right);
	};
	visit(frame.root, "root", frame.width);
	for (const row of rows) row.sort((a, b) => a.columnStart - b.columnStart);
	return mapped ? rows : undefined;
}

// Keep only the latest clip for each source snapshot, not a cache entry for every resize.
const clippedMaps = new WeakMap<
	readonly string[],
	{ map: SelectionMap; left: number; right: number; result: SelectionMap }
>();

/** A partially visible pane must not recover its horizontally hidden text between selected rows. */
export function getClippedSelectionMap(
	lines: readonly string[],
	left: number,
	right: number,
): SelectionMap | undefined {
	lines = snapshotSelectionLines(lines);
	const map = getSelectionMap(lines);
	if (map === undefined) return undefined;
	const cached = clippedMaps.get(lines);
	if (cached?.map === map && cached.left === left && cached.right === right) return cached.result;
	const rows: CopySpan[][] = Array.from({ length: lines.length }, () => []);
	projectSelectionPart(rows, {
		lines,
		row: 0,
		column: 0,
		width: right,
		flow: "clip",
		clip: { x: left, y: 0, width: Math.max(0, right - left), height: lines.length },
	});
	clippedMaps.set(lines, { map, left, right, result: rows });
	return rows;
}
