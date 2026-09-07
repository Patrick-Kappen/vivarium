import assert from "node:assert/strict";
import { it } from "node:test";
import { Text } from "../src/components/text.ts";
import { preserveSelection } from "../src/preserve-selection.ts";
import { getSelectionMap } from "../src/selection-map.ts";
import { select, withSelection } from "./selection-test-utils.ts";

for (const mode of ["implicit", "scroll", "viewport"] as const) {
	it(`copies content through a declared frame without its header, borders or wraps (${mode})`, async () => {
		const original = "alpha\tbeta gamma delta  ";
		const text = new Text(original, 0, 0);
		let height = 0;
		const frame = {
			render(width: number) {
				const content = text.render(width - 2);
				height = content.length;
				const output = ["HEADER", ...content.map((line) => `|${line}|`), "FOOTER"];
				preserveSelection(output, content, { row: 1, column: 1, width: width - 2 });
				return output;
			},
			invalidate() {
				text.invalidate();
			},
		};
		await withSelection(frame, 14, mode, async (fixture) => {
			select(fixture, 1, 1, 12, height);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, [original]);
		});
		await withSelection(frame, 14, mode, async (fixture) => {
			select(fixture, 0, 0, 5, 0);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
		});
	});
}

it("does not inherit hidden source after rewriting or clipping the content rectangle", () => {
	const content = new Text("secret original", 0, 0).render(20);
	for (const output of [["|public             |"], ["|secret|"]]) {
		preserveSelection(output, content, { row: 0, column: 1, width: 20 });
		assert.equal(getSelectionMap(output), undefined);
	}
});

it("forwards only terminal styling and excludes padding outside the content", () => {
	const content = new Text("hello", 0, 0).render(10);
	const output = [`\x1b]133;A\x07\x1b[31m${content[0]}\x1b[0m`];
	preserveSelection(output, content, { row: 0, column: 0, width: 10 });
	assert.equal(getSelectionMap(output)?.[0]?.[0]?.source.text, "hello");
});

it("rejects invalid placements and preserves a source snapshot after mutation", () => {
	const content = new Text("hello", 0, 0).render(10);
	const output = [...content];
	preserveSelection(output, content, { row: 0, column: 0, width: 10 });
	content[0] = "rewritten";
	assert.equal(getSelectionMap(output)?.[0]?.[0]?.source.text, "hello");
	for (const width of [0, -1, NaN, Infinity]) {
		preserveSelection(output, content, { row: 0, column: 0, width });
		assert.equal(getSelectionMap(output), undefined);
	}
});
