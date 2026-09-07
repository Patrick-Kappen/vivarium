import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
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
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

function copy(component: Markdown, width: number): string | undefined {
	const lines = component.render(width);
	return selectionText(lines, getSelectionMap(lines), 0, lines.length - 1, () => ({ start: 0, end: width }), width);
}

describe("paragraph source provenance", () => {
	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`preserves paragraph tabs and mixed line endings through wrapping (${mode})`, async () => {
			const text = "alpha\tbeta\r\nnext words\rmore\ttext\nlast\t";
			for (const width of [8, 20, 40]) {
				const component = new Markdown(text, 1, 1, theme);
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [text]);
				});
			}
		});

		it(`copies escaped punctuation and code tabs without their syntax (${mode})`, async () => {
			const component = new Markdown("a\\*b\t`c\td`\r\nnext\\_word", 1, 1, theme);
			for (const width of [8, 30]) {
				await withSelection(component, width, mode, async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, ["a*b\tc\td\r\nnext_word"]);
				});
			}
		});

		it(`copies nested emphasis and strikes without restoring delimiters (${mode})`, async () => {
			const text = "**bold\t*italic\r\n~~gone\\*~~*** end\t`code`";
			const component = new Markdown(text, 1, 1, {
				...theme,
				bold: (text) => `\x1b[1m${text}\x1b[22m`,
				italic: (text) => `\x1b[3m${text}\x1b[23m`,
				strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
			});
			await withSelection(component, 10, mode, async (fixture) => {
				select(fixture, 0, 0, 9, component.render(10).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["bold\titalic\r\ngone* end\tcode"]);
			});
		});

		it(`preserves hard-break newlines but not their Markdown markers (${mode})`, async () => {
			const component = new Markdown("**one\tword**  \r\ntwo\\\r\nend", 0, 0, theme, undefined, {
				preserveBackslashEscapes: true,
			});
			await withSelection(component, 12, mode, async (fixture) => {
				select(fixture, 0, 0, 11, component.render(12).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["one\tword\r\ntwo\r\nend"]);
			});
		});

		for (const hyperlinks of [false, true]) {
			it(`copies only visible explicit-link content (${mode}, hyperlinks=${hyperlinks})`, async () => {
				const previous = getCapabilities();
				setCapabilities({ ...previous, hyperlinks });
				try {
					const component = new Markdown(
						'before\t[**a\tb**](https://example.test/private "hidden title")  \r\nend',
						0,
						0,
						theme,
					);
					await withSelection(component, 16, mode, async (fixture) => {
						select(fixture, 0, 0, 15, component.render(16).length - 1);
						assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
						assert.deepEqual(fixture.copied, [
							`before\ta\tb${hyperlinks ? "" : " (https://example.test/private)"}\r\nend`,
						]);
					});
				} finally {
					setCapabilities(previous);
				}
			});
		}

		it(`copies inline-code line breaks as visible spaces (${mode})`, async () => {
			const component = new Markdown("before\t` one\r\ntwo `\r\nafter", 0, 0, theme);
			await withSelection(component, 12, mode, async (fixture) => {
				select(fixture, 0, 0, 11, component.render(12).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["before\tone two\r\nafter"]);
			});
		});

		it(`selects a partial expanded tab without neighbouring text (${mode})`, async () => {
			await withSelection(new Markdown("a\tb", 0, 0, theme), 20, mode, async (fixture) => {
				select(fixture, 2, 0, 3, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["\t"]);
			});
		});

		it(`does not restore an unselected paragraph prefix (${mode})`, async () => {
			await withSelection(new Markdown("hidden\tvisible", 0, 0, theme), 30, mode, async (fixture) => {
				select(fixture, 9, 0, 15, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["visible"]);
			});
		});

		it(`retains an unchanged paragraph through measurement and appends (${mode})`, async () => {
			const component = new Markdown("first\tparagraph", 0, 0, theme);
			await withSelection(component, 30, mode, async (fixture) => {
				select(fixture, 0, 0, 16, 0);
				component.render(8);
				component.setText("first\tparagraph\n\nafterwards");
				fixture.tui.renderNow();
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["first\tparagraph"]);
			});
		});

		it(`invalidates equal pixels with changed original text (${mode})`, async () => {
			const component = new Markdown("first\tparagraph", 0, 0, theme);
			await withSelection(component, 30, mode, async (fixture) => {
				select(fixture, 0, 0, 16, 0);
				component.setText("first   paragraph");
				fixture.tui.renderNow();
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
			});
		});
	}

	it("keeps Unicode boundaries beside tabs and CRLF", () => {
		const text = "\ud83d\ude00\tCafe\u0301\r\n\u7d42\u308f\u308a";
		for (const width of [5, 8, 20]) assert.equal(copy(new Markdown(text, 0, 0, theme), width), text);
	});

	it("does not inherit a source through a rewriting text style", () => {
		const component = new Markdown("secret\tvalue", 0, 0, theme, { color: () => "visible" });
		assert.equal(copy(component, 30), "visible");
	});

	it("records transformed input and accepts styling-only callbacks", () => {
		const component = new Markdown(
			"hidden",
			0,
			0,
			theme,
			{ color: (text) => `\x1b[31m${text}\x1b[0m` },
			{ transform: () => "visible\ttext\r\nnext" },
		);
		assert.equal(copy(component, 12), "visible\ttext\r\nnext");
	});

	it("honours explicitly preserved backslash escapes", () => {
		const text = "a\\*b\t`code`\\_end";
		const component = new Markdown(text, 0, 0, theme, undefined, { preserveBackslashEscapes: true });
		assert.equal(copy(component, 8), "a\\*b\tcode\\_end");
	});

	it("retains literal backticks inside a wider code delimiter", () => {
		assert.equal(copy(new Markdown("before\t`` `a\tb` ``", 0, 0, theme), 12), "before\t`a\tb`");
	});

	it("keeps all-space inline code and its declared tab expansion", () => {
		assert.equal(copy(new Markdown("a\t`\t` end", 0, 0, theme), 8), "a\t\t end");
	});

	it("does not restore a tab partially consumed by inline-code trimming", () => {
		const component = new Markdown("a `\tx `", 0, 0, theme);
		assert.equal(getSelectionMap(component.render(30)), undefined);
		assert.equal(copy(component, 30), "a   x");
	});

	it("rejects equal-width code-style rewrites instead of inheriting hidden source", () => {
		const component = new Markdown("a\t`secret`", 0, 0, { ...theme, code: () => "public" });
		assert.equal(copy(component, 30), "a   public");
	});

	it("keeps source identity through unchanged inline-code paragraph appends", async () => {
		const component = new Markdown("a\\*b\t`code`", 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 9, 0);
			component.render(8);
			component.setText("a\\*b\t`code`\n\nafter");
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["a*b\tcode"]);
		});
	});

	it("retains unmatched literal delimiters and intraword underscores", () => {
		assert.equal(
			copy(new Markdown("**bold** *literal\tfoo_bar ~single~", 0, 0, theme), 12),
			"bold *literal\tfoo_bar ~single~",
		);
	});

	it("does not inherit a source through an equal-width emphasis rewrite", () => {
		assert.equal(copy(new Markdown("**secret**\tend", 0, 0, { ...theme, bold: () => "public" }), 30), "public   end");
	});

	it("preserves escapes inside nested formatting when requested", () => {
		const component = new Markdown("**a\\*\t_b\\__**", 0, 0, theme, undefined, { preserveBackslashEscapes: true });
		assert.equal(copy(component, 30), "a\\*\tb\\_");
	});

	it("excludes a tab consumed entirely as hard-break syntax", () => {
		assert.equal(copy(new Markdown("a\t\r\nb", 0, 0, theme), 20), "a\r\nb");
	});

	it("does not duplicate an explicitly printed matching mailto label", () => {
		const previous = getCapabilities();
		setCapabilities({ ...previous, hyperlinks: false });
		try {
			assert.equal(
				copy(new Markdown("a\t[user@example.test](mailto:user@example.test)", 0, 0, theme), 20),
				"a\tuser@example.test",
			);
		} finally {
			setCapabilities(previous);
		}
	});

	it("does not inherit a hidden URL through a rewriting link style", () => {
		const previous = getCapabilities();
		setCapabilities({ ...previous, hyperlinks: true });
		try {
			const component = new Markdown("a\t[secret](https://example.test/hidden)", 0, 0, {
				...theme,
				link: () => "public",
			});
			assert.equal(copy(component, 30), "a   public");
		} finally {
			setCapabilities(previous);
		}
	});

	it("retains fallback for untraced label unescaping", () => {
		for (const text of ["a\t[x\\[y\\]](https://example.test)", "[ref]: /target\n\na\t[x\\[y\\]][ref]"]) {
			const component = new Markdown(text, 0, 0, theme);
			assert.ok(!copy(component, 80)?.includes("\t"));
		}
	});

	for (const hyperlinks of [false, true]) {
		it(`maps reference labels and automatic links (hyperlinks=${hyperlinks})`, () => {
			const previous = getCapabilities();
			setCapabilities({ ...previous, hyperlinks });
			try {
				for (const syntax of ["[la\tbel][ref]", "[ref][]", "[ref]"]) {
					const label = syntax.startsWith("[la") ? "la\tbel" : "ref";
					const component = new Markdown(`[ref]: /target "hidden title"\n\na\t${syntax}`, 0, 0, theme);
					assert.equal(copy(component, 20), `\na\t${label}${hyperlinks ? "" : " (/target)"}`);
				}
				const text = "a\t<user@example.test> <https://example.test> www.example.test";
				assert.equal(
					copy(new Markdown(text, 0, 0, theme), 20),
					`a\tuser@example.test https://example.test www.example.test${hyperlinks ? "" : " (http://www.example.test)"}`,
				);
			} finally {
				setCapabilities(previous);
			}
		});
	}

	it("keeps unsupported inline transformations explicitly untraced", () => {
		for (const text of [
			"**![alt](https://example.test/image)**\ttext",
			"label\r\n<span>text</span>",
			"**a**\\*b\t<img src='hidden'>",
			"a\t`code` $x^2$",
			"a\t![alt](https://example.test/image)",
		]) {
			assert.equal(getSelectionMap(new Markdown(text, 0, 0, theme).render(30)), undefined);
		}
	});

	it("does not invent original source blank lines collapsed by rendering", () => {
		assert.equal(copy(new Markdown("first\ttext\r\n\r\n\r\nlast", 0, 0, theme), 30), "first\ttext\n\nlast");
	});

	it("does not search past omitted definitions for a similar paragraph", () => {
		const component = new Markdown("[x]: /one\n[x]: /two\n\nvalue\ttext", 0, 0, theme);
		assert.equal(copy(component, 30), "\nvalue   text");
	});

	it("keeps old source snapshots after mutation", () => {
		const component = new Markdown("first\ttext\r\nnext", 0, 0, theme);
		const old = component.render(20);
		component.setText("other");
		component.render(8);
		assert.equal(
			selectionText(old, getSelectionMap(old), 0, old.length - 1, () => ({ start: 0, end: 20 }), 20),
			"first\ttext\r\nnext",
		);
	});
});
