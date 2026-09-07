import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { MarkdownSource } from "../src/markdown-source.ts";
import { MarkdownSourceView } from "../src/markdown-source-view.ts";
import { getSelectionMap, selectionText } from "../src/selection-map.ts";
import { select, withSelection } from "./selection-test-utils.ts";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

function copy(component: Markdown, width: number): string | undefined {
	const lines = component.render(width);
	return selectionText(lines, getSelectionMap(lines), 0, lines.length - 1, () => ({ start: 0, end: width }), width);
}

describe("nested Markdown source provenance", () => {
	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		for (const [name, input, expected] of [
			["nested quotes", "> > **alpha\tbeta**\r\n> > next", "alpha\tbeta\r\nnext"],
			[
				"tasks and continuation",
				"- [x] **first\titem**\r\n  next\r\n- second\titem",
				"- [x] first\titem\r\nnext\n- second\titem",
			],
			["nested lists", "- outer\ttext\r\n  - inner\ttext", "- outer\ttext\n    - inner\ttext"],
			["code inside a quoted list", "> - ```\r\n>   \tvalue  \r\n>   ```", "- \tvalue  "],
			["a quote inside a list", "- > first\tline\r\n  > second", "- first\tline\r\nsecond"],
		] as const) {
			it(`copies ${name} through source views (${mode})`, async () => {
				for (const width of [12, 30]) {
					const component = new Markdown(input, 1, 1, theme);
					await withSelection(component, width, mode, async (fixture) => {
						select(fixture, 0, 0, width - 1, component.render(width).length - 1);
						assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
						assert.deepEqual(fixture.copied, [expected]);
					});
				}
			});
		}
	}

	it("keeps initial wrap whitespace only when its anchor is selected", () => {
		const component = new Markdown("```\n\tvalue\n```", 0, 0, theme);
		assert.equal(copy(component, 6), "\tvalue");
		const lines = component.render(6);
		const row = lines.findIndex((line) => line.trim() === "value");
		assert.ok(row >= 0);
		assert.equal(
			selectionText(lines, getSelectionMap(lines), row, row, () => ({ start: 0, end: 6 }), 6),
			"value",
		);
	});

	it("keeps nested selection through unchanged streaming appends", async () => {
		const component = new Markdown("> - first\titem", 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			component.render(12);
			component.setText("> - first\titem\r\n> - next");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["- first\titem"]);
		});
	});

	it("does not restore a partially removed quote-prefix tab", () => {
		assert.equal(copy(new Markdown(">\tvalue", 0, 0, theme), 30), "  value");
	});

	it("does not restore rewritten quoted code", () => {
		const component = new Markdown("> ```\r\n> \tsecret\r\n> ```", 0, 0, {
			...theme,
			highlightCode: () => ["public"],
		});
		assert.equal(copy(component, 30), "  public");
	});

	it("keeps old nested snapshots and invalidates changed logical sources", async () => {
		const component = new Markdown("> - first\titem", 0, 0, theme);
		const old = component.render(30);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, old.length - 1);
			component.render(12);
			component.setText("> - first   item");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
		});
		assert.equal(
			selectionText(old, getSelectionMap(old), 0, old.length - 1, () => ({ start: 0, end: 30 }), 30),
			"- first\titem",
		);
	});

	it("retains literal quote and bullet characters inside code", () => {
		assert.equal(copy(new Markdown("> ```\r\n> >\t- literal\r\n> ```", 0, 0, theme), 12), ">\t- literal");
	});
});

describe("Markdown removal views", () => {
	it("composes declared deletions without losing original newline boundaries", () => {
		const source = new MarkdownSource("> a\t\r\n> b");
		const view = new MarkdownSourceView(source, [
			{ start: 2, end: 7 },
			{ start: 9, end: 10 },
		]);
		assert.equal(view.text, "a   \nb");
		assert.equal(view.slice(0, view.text.length), "a\t\r\nb");
		assert.equal(view.slice(2, 3), undefined);
		const nested = new MarkdownSourceView(view, [{ start: 1, end: 5 }]);
		assert.equal(nested.slice(0, 4), "\t\r\n");
	});

	it("rejects invalid view ranges and slices", () => {
		const source = new MarkdownSource("abc");
		assert.throws(() => new MarkdownSourceView(source, [{ start: 0, end: 4 }]), RangeError);
		assert.throws(
			() =>
				new MarkdownSourceView(source, [
					{ start: 2, end: 3 },
					{ start: 0, end: 1 },
				]),
			RangeError,
		);
		const view = new MarkdownSourceView(source, [{ start: 0, end: 3 }]);
		assert.throws(() => view.slice(-1, 2), RangeError);
	});
});
