import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getSelectionMap, selectionText } from "../src/selection-map.ts";
import { getCapabilities, setCapabilities } from "../src/terminal-image.ts";
import { Container } from "../src/tui.ts";
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

const simple = "| A | B |\n| --- | --- |\n| red | blue |";

describe("Markdown table selection", () => {
	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`copies cell content without borders and padding (${mode})`, async () => {
			const component = new Markdown(simple, 1, 1, theme);
			await withSelection(component, 30, mode, async (fixture) => {
				select(fixture, 0, 0, 29, component.render(30).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["A\tB\nred\tblue"]);
			});
		});

		it(`does not select a table border (${mode})`, async () => {
			const component = new Markdown(simple, 0, 0, theme);
			await withSelection(component, 30, mode, async (fixture) => {
				fixture.terminal.writes.length = 0;
				select(fixture, 0, 0, 29, 0);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), false);
				assert.ok(!fixture.terminal.writes.join("").includes("\x1b[7m"));
			});
		});

		it(`joins logical wraps in an uninterrupted cell (${mode})`, async () => {
			const component = new Markdown("| Name |\n| --- |\n| alpha beta gamma |", 0, 0, theme);
			await withSelection(component, 8, mode, async (fixture) => {
				select(fixture, 0, 0, 7, component.render(8).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["Name\nalpha beta gamma"]);
			});
		});

		it(`copies logical row order for wrapped adjacent cells (${mode})`, async () => {
			const component = new Markdown("| A | B |\n| --- | --- |\n| abcdef | uvwxyz |", 0, 0, theme);
			await withSelection(component, 13, mode, async (fixture) => {
				select(fixture, 0, 0, 12, component.render(13).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["A\tB\nabcdef\tuvwxyz"]);
				select(fixture, 0, 3, 12, 3);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.equal(fixture.copied.at(-1), "abc\tuvw");
			});
		});

		it(`copies visible raw syntax in the narrow fallback (${mode})`, async () => {
			const component = new Markdown(simple, 0, 0, theme);
			await withSelection(component, 6, mode, async (fixture) => {
				select(fixture, 0, 0, 5, component.render(6).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, [simple]);
			});
		});
	}

	for (const mode of ["implicit", "scroll", "viewport"] as const) {
		it(`orders only the selected cell fragments (${mode})`, async () => {
			const component = new Markdown("| A | B |\n| --- | --- |\n| abcdef | uvwxyz |", 0, 0, theme);
			await withSelection(component, 13, mode, async (fixture) => {
				select(fixture, 9, 3, 3, 4);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["de\tvw"]);
			});
		});

		it(`keeps the screen boundary when a short final cell precedes neighbouring content (${mode})`, async () => {
			const table = new Markdown("| A | B |\n| --- | --- |\n| abcdefghijklmnopqrst | Z |", 0, 0, theme);
			const note = new VStack([
				{ component: new Text("", 0, 0), basis: 6, shrink: 0 },
				{ component: new Text("note", 0, 0), basis: 1, shrink: 0 },
			]);
			const stack = new HStack(
				[
					{ component: table, basis: 13, shrink: 0 },
					{ component: note, basis: 4, shrink: 0 },
				],
				{ gap: 1 },
			);
			await withSelection(stack, 18, mode, async (fixture) => {
				select(fixture, 0, 0, 17, stack.render(18).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["A\tB\nabcdefghijklmnopqrst\tZ\tnote"]);
			});
		});

		it(`keeps repeated cached tables in distinct horizontal occurrences (${mode})`, async () => {
			const shared = new Markdown("| abcdef | uvwxyz |\n| --- | --- |", 0, 0, theme);
			const stack = new HStack(
				[
					{ component: shared, basis: 13, shrink: 0 },
					{ component: shared, basis: 13, shrink: 0 },
				],
				{ gap: 2 },
			);
			await withSelection(stack, 28, mode, async (fixture) => {
				select(fixture, 0, 0, 27, stack.render(28).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["abc\tuvw\tabc\tuvw\ndef\txyz\tdef\txyz"]);
			});
		});
	}

	it("preserves cell wrap whitespace and an empty trailing column", async () => {
		const component = new Markdown("| A | B | C |\n| --- | --- | --- |\n| alpha beta | gamma delta | |", 0, 0, theme);
		await withSelection(component, 19, "scroll", async (fixture) => {
			select(fixture, 0, 0, 18, component.render(19).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["A\tB\tC\nalpha beta\tgamma delta\t"]);
		});
	});

	it("keeps repeated cached header-only tables in distinct vertical occurrences", async () => {
		const shared = new Markdown("| abcdef | uvwxyz |\n| --- | --- |", 0, 0, theme);
		const container = new Container();
		container.addChild(shared);
		container.addChild(shared);
		await withSelection(container, 13, "scroll", async (fixture) => {
			select(fixture, 0, 0, 12, container.render(13).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["abcdef\tuvwxyz\nabcdef\tuvwxyz"]);
		});
	});

	it("forwards a table inside quotes and lists", async () => {
		for (const [input, expected] of [
			[
				simple
					.split("\n")
					.map((line) => `> ${line}`)
					.join("\n"),
				"A\tB\nred\tblue",
			],
			["- | A | B |\n  | --- | --- |\n  | red | blue |", "- A\tB\nred\tblue"],
		]) {
			for (const width of [13, 30]) {
				const component = new Markdown(input, 0, 0, theme);
				await withSelection(component, width, "scroll", async (fixture) => {
					select(fixture, 0, 0, width - 1, component.render(width).length - 1);
					assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
					assert.deepEqual(fixture.copied, [expected]);
				});
			}
		}
	});

	it("keeps equal-width rewritten headers local to visible text", async () => {
		const component = new Markdown(simple, 0, 0, { ...theme, bold: (text) => text.replace("A", "X") });
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["X\tB\nred\tblue"]);
		});
	});

	it("rejects table geometry changed by a header callback", () => {
		const component = new Markdown(simple, 0, 0, { ...theme, bold: (text) => `changed ${text}` });
		const lines = component.render(60);
		const copied = selectionText(
			lines,
			getSelectionMap(lines),
			0,
			lines.length - 1,
			() => ({ start: 0, end: 60 }),
			60,
		);
		assert.ok(copied?.includes("changed"));
		assert.ok(copied?.includes("\u2502"), "invalid table geometry stays explicitly legacy");
	});

	it("preserves empty cells and literal border characters used as cell content", async () => {
		const component = new Markdown("| A | B |\n| --- | --- |\n| | literal \u2502 |", 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["A\tB\n\tliteral \u2502"]);
		});
	});

	it("retains a header selection through measurement and width-preserving row appends", async () => {
		const component = new Markdown(simple, 0, 0, theme);
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 1, 29, 1);
			component.render(13);
			component.setText(`${simple}\n| two | one |`);
			fixture.tui.renderNow();
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["A\tB"]);
		});
	});

	it("old table snapshots do not read later cell content", () => {
		const component = new Markdown(simple, 0, 0, theme);
		const old = component.render(30);
		component.setText(simple.replace("red", "black"));
		component.render(30);
		assert.equal(
			selectionText(old, getSelectionMap(old), 0, old.length - 1, () => ({ start: 0, end: 30 }), 30),
			"A\tB\nred\tblue",
		);
	});

	it("copies transformed table output rather than its original input", async () => {
		const component = new Markdown("original", 0, 0, theme, undefined, { transform: () => simple });
		await withSelection(component, 30, "scroll", async (fixture) => {
			select(fixture, 0, 0, 29, component.render(30).length - 1);
			assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(fixture.copied, ["A\tB\nred\tblue"]);
		});
	});

	it("does not copy an OSC 8 URL hidden inside a cell", async () => {
		const previous = getCapabilities();
		setCapabilities({ ...previous, hyperlinks: true });
		try {
			const component = new Markdown("| Link |\n| --- |\n| [shown](https://hidden.example) |", 0, 0, theme);
			await withSelection(component, 20, "scroll", async (fixture) => {
				select(fixture, 0, 0, 19, component.render(20).length - 1);
				assert.equal(await fixture.tui.copyActiveSelectionToClipboard(), true);
				assert.deepEqual(fixture.copied, ["Link\nshown"]);
			});
		} finally {
			setCapabilities(previous);
		}
	});
});
