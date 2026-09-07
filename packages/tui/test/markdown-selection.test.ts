import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { MarkdownSelection } from "../src/markdown-selection.ts";
import { getSelectionMap, selectionText, setSelectionMap } from "../src/selection-map.ts";
import { getCapabilities, setCapabilities } from "../src/terminal-image.ts";
import { stripTerminalSequences } from "../src/utils.ts";
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

	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`copies wrapped quote content without its border (${mode})`, async () => {
			for (const width of [8, 16, 40]) {
				const component = new Markdown("> **alpha** beta gamma delta epsilon", 1, 1, theme);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, ["alpha beta gamma delta epsilon"]);
				});
			}
		});

		it(`preserves code and whitespace inside nested quotes (${mode})`, async () => {
			const source = "function f() {\n\n    \n  return 42;  \n}";
			const quoted = ["```js", ...source.split("\n"), "```"].map((line) => `> > ${line}`).join("\n");
			for (const width of [8, 16, 40]) {
				const component = new Markdown(quoted, 1, 1, theme);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [source]);
				});
			}
		});

		it(`does not copy or highlight quote borders but retains literal border content (${mode})`, async () => {
			const component = new Markdown("> \u2502 literal", 0, 0, theme);
			await withSelection(component, 20, mode, async (fixture) => {
				fixture.terminal.writes.length = 0;
				select(fixture, 0, 0, 1, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
				assert.ok(!fixture.terminal.writes.join("").includes("\x1b[7m"));
				select(fixture, 0, 0, 19, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["\u2502 literal"]);
			});
		});
	}

	it("preserves quote styling callback order", () => {
		const calls: string[] = [];
		new Markdown("> first\n>\n> second", 0, 0, {
			...theme,
			quote: (text) => {
				calls.push(`style:${text}`);
				return text;
			},
			quoteBorder: (text) => {
				calls.push("border");
				return text;
			},
		}).render(20);
		assert.deepEqual(calls, ["style:\u0000", "style:first", "border", "style:", "border", "style:second", "border"]);
	});

	it("never restores hidden source through a rewriting quote style", async () => {
		const component = new Markdown("> secret", 0, 0, { ...theme, quote: () => "visible" });
		await withSelection(component, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 19, 0);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["visible"]);
		});
	});

	it("keeps a quoted paragraph selected through measurement and unrelated streaming appends", async () => {
		const component = new Markdown("> first paragraph", 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 2, 0, 16, 0);
			component.render(8);
			component.setText("> first paragraph\n\nafterwards");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["first paragraph"]);
		});
	});

	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`copies list markers without continuation padding or visual newlines (${mode})`, async () => {
			for (const width of [8, 16, 40]) {
				const component = new Markdown("- alpha beta gamma\n- second", 1, 1, theme);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, ["- alpha beta gamma\n- second"]);
				});
			}
		});

		it(`copies a partial list body without its marker (${mode})`, async () => {
			const component = new Markdown("- alpha beta gamma", 0, 0, theme);
			await withSelection(component, 12, mode, async (fixture) => {
				select(fixture, 2, 0, 11, component.render(12).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["alpha beta gamma"]);
			});
		});

		it(`preserves canonical nested list markers and task state (${mode})`, async () => {
			for (const width of [8, 16, 40]) {
				const component = new Markdown("- outer\n  - inner words wrap\n- [x] done", 1, 1, theme);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, ["- outer\n    - inner words wrap\n- [x] done"]);
				});
			}
		});

		it(`copies code selected inside a list without either presentation indent (${mode})`, async () => {
			const source = "function f() {\n\n  return 1;\n}";
			const input = `- item\n\n  \x60\x60\x60js\n${source
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n")}\n  \x60\x60\x60`;
			const component = new Markdown(input, 1, 1, theme);
			await withSelection(component, 40, mode, async (fixture) => {
				const lines = component.render(40).map(stripTerminalSequences);
				const first = lines.findIndex((line) => line.includes("function f()"));
				const last = lines.findIndex((line) => line.trim() === "}");
				assert.ok(first >= 0 && last > first);
				select(fixture, 0, first, 39, last);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, [source]);
			});
		});

		it(`forwards quote content inside a list (${mode})`, async () => {
			for (const width of [8, 16, 40]) {
				const component = new Markdown("- > alpha beta gamma", 1, 1, theme);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, ["- alpha beta gamma"]);
				});
			}
		});

		it(`copies the rendered block formula, including its intrinsic alignment (${mode})`, async () => {
			for (const width of [8, 20, 40]) {
				const component = new Markdown(
					String.raw`\[E \approx \frac{0.1\ \text{lux}}{100\ \text{lm/W}}\]`,
					1,
					1,
					theme,
				);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [
						"    0.1 lux\nE \u2248 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    100 lm/W",
					]);
				});
			}
		});
	}

	for (const preserveOrderedListMarkers of [false, true]) {
		it(`copies the displayed ordered-list numbering (preserve=${preserveOrderedListMarkers})`, async () => {
			const component = new Markdown("1. first\n7. second", 0, 0, theme, undefined, { preserveOrderedListMarkers });
			await withSelection(component, 20, "scroll", async (fixture) => {
				select(fixture, 0, 0, 19, component.render(20).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, [
					preserveOrderedListMarkers ? "1. first\n7. second" : "1. first\n2. second",
				]);
			});
		});
	}

	it("preserves nested list structure inside a quote", async () => {
		for (const width of [8, 16, 40]) {
			const component = new Markdown("> - alpha beta gamma\n>   - child", 1, 1, theme);
			await withSelection(component, width, "scroll", async (fixture) => {
				select(fixture, 0, 0, width - 1, component.render(width).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["- alpha beta gamma\n    - child"]);
			});
		}
	});

	it("retains loose-list separation and empty markers", async () => {
		for (const source of ["- first\n\n- second", "-\n-\n- end"]) {
			const component = new Markdown(source, 0, 0, theme);
			await withSelection(component, 30, "scroll", async (fixture) => {
				select(fixture, 0, 0, 29, component.render(30).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, [source]);
			});
		}
	});

	it("does not restore hidden leading source when joining a semantic marker", () => {
		const body = ["visible"];
		setSelectionMap(body, () => [
			[{ source: { text: "hidden visible" }, start: 7, end: 14, columnStart: 0, columnEnd: 7 }],
		]);
		const lines = ["- visible"];
		new MarkdownSelection([]).decoratePrefix(lines, body, ["- "], true);
		assert.equal(
			selectionText(lines, getSelectionMap(lines), 0, 0, () => ({ start: 0, end: 20 }), 20),
			"- visible",
		);
	});

	it("joins a marker only to its first body's layout lane", () => {
		const source = { text: "abc" };
		const body = ["c abc"];
		setSelectionMap(body, () => [
			[
				{ source, flow: "first", start: 2, end: 3, columnStart: 0, columnEnd: 1 },
				{ source, flow: "second", start: 0, end: 3, columnStart: 2, columnEnd: 5 },
			],
		]);
		const lines = ["- c abc"];
		new MarkdownSelection([]).decoratePrefix(lines, body, ["- "], true);
		assert.equal(
			selectionText(lines, getSelectionMap(lines), 0, 0, () => ({ start: 0, end: 20 }), 20),
			"- c\tabc",
		);
	});

	it("keeps rewritten code in a list local to visible legacy output", async () => {
		const component = new Markdown("- ```\n  original\n  ```", 0, 0, { ...theme, highlightCode: () => ["changed"] });
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["-   changed"]);
		});
	});

	it("retains visible literal math syntax when rendering is disabled", async () => {
		const component = new Markdown("$$\nx^2\n$$", 0, 0, theme, undefined, { renderLatex: false });
		await withSelection(component, 20, "scroll", async (fixture) => {
			select(fixture, 0, 0, 19, component.render(20).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["$$\nx^2\n$$"]);
		});
	});

	it("keeps list selection through measurement renders and appended items", async () => {
		const component = new Markdown("- first paragraph", 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 16, 0);
			component.render(8);
			component.setText("- first paragraph\n- second paragraph");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["- first paragraph"]);
		});
	});

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

	it("validates inherited block metadata only once per wrapped snapshot", () => {
		let reads = 0;
		const block = Array.from({ length: 200 }, () => "line");
		Object.defineProperty(block, 0, {
			get: () => {
				reads++;
				return "line";
			},
		});
		setSelectionMap(block, () => block.map(() => []));
		const wrapped = new MarkdownSelection([]).wrap([block], 10);
		reads = 0;
		getSelectionMap(wrapped);
		assert.equal(reads, 2, "one snapshot validation and one factory evaluation, not a scan per row");
	});

	it("retains explicit legacy fallback for untraced rich prose", () => {
		for (const input of ["![a](https://example.test/image)\tb", "<b>a</b>\r\nb"]) {
			assert.equal(getSelectionMap(new Markdown(input, 0, 0, theme).render(20)), undefined);
		}
	});
});
