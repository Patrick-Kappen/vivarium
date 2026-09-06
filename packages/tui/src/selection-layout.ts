import type { LayoutBox, LayoutFrame } from "./layout.ts";
import { type CopySpan, getSelectionMap, type SelectionMap } from "./selection-map.ts";

/** Full-width leaf projection only; horizontal/clipped composition remains legacy. */
export function getViewportSelectionMap(frame: LayoutFrame): SelectionMap | undefined {
	const rows: (readonly CopySpan[] | undefined)[] = Array.from({ length: frame.height }, () => undefined);
	let supported = true;
	let mapped = false;
	const visit = (box: LayoutBox): void => {
		if (box.lines) {
			if (box.rect.x !== 0 || box.rect.width < frame.width || box.clip.x !== 0 || box.clip.width < frame.width) {
				supported = false;
				return;
			}
			const map = getSelectionMap(box.lines);
			mapped ||= map !== undefined;
			const first = Math.max(0, box.rect.y, box.clip.y);
			const end = Math.min(frame.height, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
			for (let row = first; row < end; row++) rows[row] = map?.[(box.lineOffset ?? 0) + row - box.rect.y];
		}
		for (const child of box.children) visit(child);
	};
	visit(frame.root);
	return supported && mapped ? rows : undefined;
}
