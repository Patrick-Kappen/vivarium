import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
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

describe("original fenced-code provenance", () => {
	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`copies original tabs, blank lines, tails and mixed newline sequences (${mode})`, async () => {
			const code = "target:\r\n\tcommand\targs  \n\t\r\nnext\r\tfinal\t";
			for (const width of [8, 20, 50]) {
				const component = new Markdown(`\x60\x60\x60make\r\n${code}\r\n\x60\x60\x60`, 1, 1, theme);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [code]);
				});
			}
		});

		it(`copies one tab from a partial selection of its displayed cells (${mode})`, async () => {
			const component = new Markdown("```\na\tb\n```", 0, 0, theme);
			await withSelection(component, 20, mode, async (fixture) => {
				select(fixture, 4, 1, 5, 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["\t"]);
			});
		});

		it(`removes fenced syntax indentation but keeps code tabs and CRLF (${mode})`, async () => {
			const component = new Markdown("  ```\r\n  \tfirst\t\r\n x\r\n  \r\n    last  \r\n  ```", 0, 0, theme);
			await withSelection(component, 14, mode, async (fixture) => {
				select(fixture, 0, 0, 13, component.render(14).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["\tfirst\t\r\n x\r\n\r\n  last  "]);
			});
		});

		it(`maps indented code without restoring its four-space Markdown prefix (${mode})`, async () => {
			const component = new Markdown("    \tfirst\t\r\n\r\n      next  ", 0, 0, theme);
			await withSelection(component, 14, mode, async (fixture) => {
				select(fixture, 0, 0, 13, component.render(14).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["\tfirst\t\r\n\r\n  next  "]);
			});
		});

		it(`does not restore an unselected leading tab (${mode})`, async () => {
			const component = new Markdown("```\n\tvalue\n```", 0, 0, theme);
			await withSelection(component, 20, mode, async (fixture) => {
				select(fixture, 5, 1, 9, 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["value"]);
			});
		});

		it(`invalidates equal-looking selections when original bytes change (${mode})`, async () => {
			const component = new Markdown("```\n\tfirst\r\nnext\n```", 0, 0, theme);
			await withSelection(component, 20, mode, async (fixture) => {
				select(fixture, 0, 0, 19, component.render(20).length - 1);
				component.render(8);
				component.setText("```\n   first\nnext\n```");
				fixture.tui.renderNow();
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
			});
		});

		it(`preserves streamed partial-fence handling without restoring its bytes (${mode})`, async () => {
			const component = new Markdown("```\r\n\tvalue\r\n``", 0, 0, theme);
			await withSelection(component, 20, mode, async (fixture) => {
				select(fixture, 0, 0, 19, component.render(20).length - 1);
				component.setText("```\r\n\tvalue\r\n```");
				fixture.tui.renderNow();
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["\tvalue"]);
			});
		});
	}

	it("keeps Unicode source boundaries beside expanded tabs and CRLF", () => {
		const code = "\ud83d\ude00\tCafe\u0301\r\n\t\u7d42\u308f\u308a  ";
		const component = new Markdown(`\x60\x60\x60\n${code}\n\x60\x60\x60`, 0, 0, theme);
		for (const width of [5, 8, 20]) {
			const lines = component.render(width);
			assert.equal(
				selectionText(lines, getSelectionMap(lines), 0, lines.length - 1, () => ({ start: 0, end: width }), width),
				code,
			);
		}
	});

	it("keeps the highlighter's normalized input and validates its styled output", async () => {
		const seen: string[] = [];
		const component = new Markdown("```js\r\n\tfirst\r\nsecond\r\n```", 0, 0, {
			...theme,
			highlightCode: (code) => {
				seen.push(code);
				return code.split("\n").map((line) => `\x1b[31m${line}\x1b[0m`);
			},
		});
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["\tfirst\r\nsecond"]);
			assert.ok(seen.length > 0);
			assert.ok(seen.every((code) => code === "   first\nsecond"));
		});
	});

	it("never restores original bytes through a rewriting highlighter", async () => {
		const component = new Markdown("```\n\tsecret\r\n```", 0, 0, { ...theme, highlightCode: () => ["visible"] });
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["  visible"]);
		});
	});

	it("copies the transform's source rather than the pre-transform input", async () => {
		const component = new Markdown("hidden input", 0, 0, theme, undefined, {
			transform: () => "~~~\r\n\tvisible\r\n~~~",
		});
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["\tvisible"]);
		});
	});

	it("retains unambiguous surrounding prose without downgrading the whole component", async () => {
		const component = new Markdown("**before**\n\n```\n\tx\n```\n\n**after**", 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["before\n\n\tx\n\nafter"]);
		});
	});

	it("does not search ahead after omitted duplicate definitions", async () => {
		const component = new Markdown("[x]: /one\n[x]: /two\n\n```\n\tvalue\n```", 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.ok(!fixture.copied[0]!.includes("\t"));
			assert.ok(fixture.copied[0]!.includes("value"));
		});
	});

	it("does not restore a whole tab consumed as fence indentation", () => {
		const component = new Markdown("   ```\r\n\tvalue\r\n   ```", 0, 0, theme);
		const lines = component.render(20);
		assert.equal(
			selectionText(lines, getSelectionMap(lines), 0, lines.length - 1, () => ({ start: 0, end: 20 }), 20),
			"value",
		);
	});

	it("retains the installed lexer's different tilde-fence indentation semantics", () => {
		const component = new Markdown("  ~~~\r\n  \tvalue\r\n  ~~~", 0, 0, theme);
		const lines = component.render(20);
		assert.equal(
			selectionText(lines, getSelectionMap(lines), 0, lines.length - 1, () => ({ start: 0, end: 20 }), 20),
			"  \tvalue",
		);
	});

	it("falls back rather than collapsing separate CR and LF after indentation removal", () => {
		const component = new Markdown("  ```\r  first\r  \n  next\r  ```", 0, 0, theme);
		const lines = component.render(20);
		assert.equal(
			selectionText(lines, getSelectionMap(lines), 0, lines.length - 1, () => ({ start: 0, end: 20 }), 20),
			"  first\n\n  next",
		);
	});

	it("retains paragraph indentation rather than treating continuation text as code", () => {
		const text = "paragraph\n    \tcontinuation";
		const component = new Markdown(text, 0, 0, theme);
		const lines = component.render(30);
		assert.equal(
			selectionText(lines, getSelectionMap(lines), 0, lines.length - 1, () => ({ start: 0, end: 30 }), 30),
			text,
		);
	});

	it("keeps partially consumed tabs in scoped legacy fallback", async () => {
		const component = new Markdown("  ```\n\tvalue\n  ```", 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["   value"]);
		});
	});

	it("old snapshots retain original bytes after equal-looking source changes", () => {
		const component = new Markdown("```\n\tx\r\ny\n```", 0, 0, theme);
		const old = component.render(20);
		component.setText("```\n   x\ny\n```");
		const current = component.render(20);
		assert.deepEqual(old, current);
		assert.equal(
			selectionText(old, getSelectionMap(old), 0, old.length - 1, () => ({ start: 0, end: 20 }), 20),
			"\tx\r\ny",
		);
		assert.equal(
			selectionText(current, getSelectionMap(current), 0, current.length - 1, () => ({ start: 0, end: 20 }), 20),
			"   x\ny",
		);
	});
});
