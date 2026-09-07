import {
	type CopySource,
	getSelectionMap,
	legacySelectionRow,
	setSelectionMap,
	snapshotSelectionLines,
} from "./selection-map.ts";

/** Stable identity and attribution for one rendered chat message. */
export interface SelectionMessage {
	readonly label: string;
}

const sources = new WeakMap<SelectionMessage, WeakMap<CopySource, CopySource>>();

/** Attribute existing visible copy sources without adding selectable header cells. */
export function setSelectionMessage(lines: string[], message: SelectionMessage): void {
	const input = snapshotSelectionLines(lines);
	let cache = sources.get(message);
	if (!cache) {
		cache = new WeakMap();
		sources.set(message, cache);
	}
	const sourceCache = cache;
	const attribute = (source: CopySource): CopySource => {
		let attributed = sourceCache.get(source);
		if (!attributed) {
			attributed = { ...source, message };
			sourceCache.set(source, attributed);
		}
		return attributed;
	};
	setSelectionMap(lines, () => {
		const map = getSelectionMap(input);
		return input.map((line, row) =>
			(map?.[row] ?? legacySelectionRow(line)).map((span) => ({
				...span,
				source: attribute(span.source),
				readingOrder: span.readingOrder
					? { ...span.readingOrder, group: attribute(span.readingOrder.group) }
					: undefined,
			})),
		);
	});
}
