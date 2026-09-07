import { projectSelectionPart } from "./selection-compose.ts";
import { type CopySpan, type SelectionMap, setSelectionMap, snapshotSelectionLines } from "./selection-map.ts";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "./utils.ts";

// One verified placement per immutable content snapshot, not one entry per redraw.
const preserved = new WeakMap<
	readonly string[],
	{
		row: number;
		column: number;
		width: number;
		output: readonly string[];
		build: () => SelectionMap | undefined;
	}
>();

/** Forward one unchanged content rectangle; everything outside it is decoration. */
export function preserveSelection(
	output: string[],
	content: readonly string[],
	placement: { row: number; column: number; width: number },
): void {
	const input = snapshotSelectionLines(content);
	const { row, column, width } = placement;
	const previous = preserved.get(input);
	if (
		previous &&
		previous.row === row &&
		previous.column === column &&
		previous.width === width &&
		previous.output.length === output.length &&
		previous.output.every((line, index) => line === output[index])
	) {
		setSelectionMap(output, previous.build);
		return;
	}
	const painted = [...output];
	const project = (): SelectionMap | undefined => {
		if (
			![row, column, width].every(Number.isSafeInteger) ||
			row < 0 ||
			column < 0 ||
			width < 1 ||
			row + input.length > painted.length
		)
			return undefined;
		for (let index = 0; index < input.length; index++) {
			const expected = stripTerminalSequences(input[index] ?? "");
			const actual = stripTerminalSequences(sliceByColumn(painted[row + index] ?? "", column, width, true));
			const expectedWidth = visibleWidth(expected);
			const actualWidth = visibleWidth(actual);
			if (expectedWidth > width || actualWidth > width || expected.replace(/ +$/, "") !== actual.replace(/ +$/, ""))
				return undefined;
		}
		const rows: CopySpan[][] = Array.from({ length: painted.length }, () => []);
		projectSelectionPart(rows, {
			lines: input,
			row,
			column,
			width,
			flow: "content",
			clip: { x: column, y: row, width, height: input.length },
		});
		return rows;
	};
	let resolved: { map: SelectionMap | undefined } | undefined;
	const build = () => {
		resolved ??= { map: project() };
		return resolved.map;
	};
	preserved.set(input, { row, column, width, output: painted, build });
	setSelectionMap(output, build);
}
