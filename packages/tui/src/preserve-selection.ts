import { projectSelectionPart } from "./selection-compose.ts";
import { type CopySpan, setSelectionMap, snapshotSelectionLines } from "./selection-map.ts";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "./utils.ts";

/** Forward one unchanged content rectangle; everything outside it is decoration. */
export function preserveSelection(
	output: string[],
	content: readonly string[],
	placement: { row: number; column: number; width: number },
): void {
	const input = snapshotSelectionLines(content);
	const { row, column, width } = placement;
	setSelectionMap(output, () => {
		if (
			![row, column, width].every(Number.isSafeInteger) ||
			row < 0 ||
			column < 0 ||
			width < 1 ||
			row + input.length > output.length
		)
			return undefined;
		for (let index = 0; index < input.length; index++) {
			const expected = stripTerminalSequences(input[index] ?? "");
			const actual = stripTerminalSequences(sliceByColumn(output[row + index] ?? "", column, width, true));
			const expectedWidth = visibleWidth(expected);
			const actualWidth = visibleWidth(actual);
			if (expectedWidth > width || actualWidth > width || expected.replace(/ +$/, "") !== actual.replace(/ +$/, ""))
				return undefined;
		}
		const rows: CopySpan[][] = Array.from({ length: output.length }, () => []);
		projectSelectionPart(rows, {
			lines: input,
			row,
			column,
			width,
			flow: "content",
			clip: { x: column, y: row, width, height: input.length },
		});
		return rows;
	});
}
