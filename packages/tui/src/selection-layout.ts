import type { LayoutBox, LayoutFrame } from "./layout.ts";
import { getLayoutNode } from "./layout-node.ts";
import { type CopySpan, getSelectionMap, type SelectionMap } from "./selection-map.ts";

/** Full-width vertical projection; horizontal/clipped-column composition remains legacy. */
export function getViewportSelectionMap(frame: LayoutFrame): SelectionMap | undefined {
	const rows: (readonly CopySpan[] | undefined)[] = Array.from({ length: frame.height }, () => []);
	let supported = true;
	let mapped = false;
	const visit = (box: LayoutBox): void => {
		if (box.clip.width <= 0 || box.clip.height <= 0) return;
		if (getLayoutNode(box.component)?.type === "vstack") mapped = true;
		if (box.lines) {
			if (box.rect.x !== 0 || box.rect.width < frame.width || box.clip.x !== 0 || box.clip.width < frame.width) {
				supported = false;
				return;
			}
			const map = getSelectionMap(box.lines);
			mapped ||= map !== undefined;
			const first = Math.max(0, box.rect.y, box.clip.y);
			const end = Math.min(frame.height, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
			let firstContent = true;
			for (let row = first; row < end; row++) {
				const sourceRow = (box.lineOffset ?? 0) + row - box.rect.y;
				if (sourceRow >= box.lines.length) continue;
				const spans = map?.[sourceRow];
				if (firstContent && spans?.length) {
					rows[row] = [{ ...spans[0]!, breakBefore: true }, ...spans.slice(1)];
					firstContent = false;
				} else rows[row] = spans;
			}
		}
		for (const child of box.children) visit(child);
	};
	visit(frame.root);
	return supported && mapped ? rows : undefined;
}
