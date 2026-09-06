import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { getSelectionMap, selectionText } from "../src/selection-map.ts";
import { getCapabilities, setCapabilities } from "../src/terminal-image.ts";
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
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

describe("Markdown emission selection metadata", () => {
	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`copies logical prose without syntax or visual wraps (${mode})`, async () => {
			for (const width of [8, 20, 60]) {
				const component = new Markdown("**alpha** beta `gamma` delta epsilon", 1, 1, theme);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, ["alpha beta gamma delta epsilon"]);
				});
			}
		});

		it(`copies code without fences or presentation indent, preserving blank lines and tails (${mode})`, async () => {
			const source = "function f() {\n\n  return 42;  \n}";
			for (const width of [8, 20, 60]) {
				const component = new Markdown(`\x60\x60\x60js\n${source}\n\x60\x60\x60`, 1, 1, theme);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [source]);
				});
			}
		});

		it(`omits a heading prefix without stripping literal code characters (${mode})`, async () => {
			const heading = new Markdown("### Heading", 0, 0, theme);
			await withSelection(heading, 20, mode, async (fixture) => {
				select(fixture, 0, 0, 19, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["Heading"]);
			});
			const code = new Markdown("~~~~\n```literal\n---\n| body |\n~~~~", 0, 0, theme);
			await withSelection(code, 20, mode, async (fixture) => {
				select(fixture, 0, 0, 19, code.render(20).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["```literal\n---\n| body |"]);
			});
		});

		it(`does not copy or highlight a code fence or horizontal rule (${mode})`, async () => {
			for (const source of ["```js\nvalue\n```", "---"]) {
				const component = new Markdown(source, 0, 0, theme);
				await withSelection(component, 20, mode, async (fixture) => {
					fixture.terminal.writes.length = 0;
					select(fixture, 0, 0, 19, 0);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
					assert.ok(!fixture.terminal.writes.join("").includes("\x1b[7m"));
				});
			}
		});
	}

	for (const hyperlinks of [false, true]) {
		it(`copies only printed link content (hyperlinks=${hyperlinks})`, async () => {
			const previous = getCapabilities();
			setCapabilities({ ...previous, hyperlinks });
			try {
				const component = new Markdown("[label](https://example.test/private)", 0, 0, theme);
				await withSelection(component, 16, "scroll", async (fixture) => {
					select(fixture, 0, 0, 15, component.render(16).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [hyperlinks ? "label" : "label (https://example.test/private)"]);
				});
			} finally {
				setCapabilities(previous);
			}
		});
	}

	it("maps transformed content, never the hidden pre-transform source", async () => {
		const widths: number[] = [];
		const component = new Markdown("hidden input", 1, 0, theme, undefined, {
			transform: (_, width) => {
				widths.push(width);
				return "**visible**";
			},
		});
		await withSelection(component, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 19, 0);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["visible"]);
			assert.deepEqual(widths, [18]);
		});
	});

	it("keeps unchanged paragraph selection through unrelated appends and measurement renders", async () => {
		const component = new Markdown("first paragraph", 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 14, 0);
			component.render(8);
			component.setText("first paragraph\n\nsecond paragraph");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["first paragraph"]);
			component.setText("changed paragraph");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
		});
	});

	it("does not restore a streamed partial closing fence", async () => {
		const component = new Markdown("```js\nvalue\n``", 0, 0, theme);
		await withSelection(component, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 19, component.render(20).length - 1);
			component.setText("```js\nvalue\n```");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["value"]);
		});
	});

	it("does not inherit original code through a rewriting highlighter", async () => {
		const component = new Markdown("```\noriginal\n```", 0, 0, {
			...theme,
			highlightCode: () => ["changed"],
		});
		await withSelection(component, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 19, 2);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["  changed"]);
		});
	});

	it("forwards styling-only highlighting and an ANSI-styled code indent", async () => {
		const source = "  value\n\nnext  ";
		const component = new Markdown(`\x60\x60\x60\n${source}\n\x60\x60\x60`, 0, 0, {
			...theme,
			codeBlockIndent: "\x1b[36m:: \x1b[0m",
			highlightCode: (code) => code.split("\n").map((line) => `\x1b[32m${line}\x1b[0m`),
		});
		await withSelection(component, 12, "scroll", async (fixture) => {
			select(fixture, 0, 0, 11, component.render(12).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, [source]);
		});
	});

	it("reads old code snapshots after later Markdown mutation", () => {
		const component = new Markdown("```\nold\n```", 0, 0, theme);
		const before = component.render(20);
		component.setText("```\nnew\n```");
		component.render(20);
		assert.equal(
			selectionText(before, getSelectionMap(before), 0, before.length - 1, () => ({ start: 0, end: 20 }), 20),
			"old",
		);
	});

	it("does not copy a clipped blank-code anchor from the neighbouring pane", () => {
		const stack = new HStack([
			{ component: new Markdown("```\n    \n```", 1, 0, theme), basis: 1, shrink: 0 },
			{ component: new Text("\n\n\nRR", 0, 0), basis: 2, shrink: 0 },
		]);
		const lines = stack.render(3);
		assert.equal(
			selectionText(lines, getSelectionMap(lines), 3, 3, () => ({ start: 1, end: 3 }), 3),
			"RR",
		);
	});

	it("retains explicit legacy fallback for missing tab and CR lexer provenance", () => {
		for (const input of ["a\tb", "```\n\tx\n```", "a\r\nb"]) {
			assert.equal(getSelectionMap(new Markdown(input, 0, 0, theme).render(20)), undefined);
		}
	});
});
