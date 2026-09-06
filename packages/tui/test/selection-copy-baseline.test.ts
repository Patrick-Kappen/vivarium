import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Text and Box cases assert corrected behavior. Remaining documented losses
// characterize Markdown and decorators that do not yet forward metadata.
interface Point {
	x: number;
	y: number;
}

async function copySelection(
	component: Component,
	width: number,
	start: Point,
	end: Point,
	options: { scroll?: boolean; resizeFrom?: number; scrollTop?: number } = {},
): Promise<string> {
	const terminal = new VirtualTerminal(options.resizeFrom ?? width, 12);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const scroll = new ScrollView(component, { primary: true, scrollbar: "hidden" });
	if (options.scroll) tui.setLayoutRoot(scroll);
	else tui.addChild(component);
	try {
		tui.start();
		await terminal.waitForRender();
		if (options.resizeFrom !== undefined) {
			terminal.resize(width, 12);
			await terminal.waitForRender();
		}
		if (options.scrollTop !== undefined) {
			scroll.scrollTo(options.scrollTop);
			await terminal.waitForRender();
		}
		terminal.sendInput(`\x1b[<0;${start.x + 1};${start.y + 1}M`);
		terminal.sendInput(`\x1b[<32;${end.x + 1};${end.y + 1}M`);
		terminal.sendInput(`\x1b[<0;${end.x + 1};${end.y + 1}m`);
		await terminal.waitForRender();
		assert.equal(copied.length, 1, "mouse release must deliver exactly one clipboard value");
		return copied[0]!;
	} finally {
		tui.stop();
	}
}

/** Deliberately generic decoration: no dependency on a managed extension. */
class FramedText implements Component {
	private content: Text;
	constructor(text: string) {
		this.content = new Text(text, 0, 0);
	}
	invalidate(): void {
		this.content.invalidate();
	}
	render(width: number): string[] {
		const lines = this.content.render(width - 2);
		return ["HEADER", ...lines.map((line) => `|${line}|`), "FOOTER"];
	}
}

const identity = (text: string): string => text;
const markdownTheme: MarkdownTheme = {
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

const longLine = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";

describe("fullscreen Text copy regressions and legacy baseline", () => {
	for (const scroll of [false, true]) {
		it(`preserves explicit newlines, blank lines and space indentation (scroll=${scroll})`, async () => {
			const source = "function example() {\n\n  return 42;\n}";
			assert.equal(
				await copySelection(new Text(source, 0, 0), 32, { x: 0, y: 0 }, { x: 0, y: 3 }, { scroll }),
				source,
			);
		});

		it(`copies a soft-wrapped logical line without an added newline (scroll=${scroll})`, async () => {
			const copied = await copySelection(new Text(longLine, 0, 0), 32, { x: 0, y: 0 }, { x: 31, y: 1 }, { scroll });
			assert.equal(copied, longLine);
		});
	}

	it("documents border characters entering a selection that starts and ends inside the body", async () => {
		const source = "first\n  middle\nlast";
		const copied = await copySelection(new FramedText(source), 16, { x: 1, y: 1 }, { x: 4, y: 3 });
		assert.equal(copied, "first         |\n|  middle      |\n|last");
		assert.notEqual(copied, source);
	});

	it("documents headers entering a selection across message components", async () => {
		const transcript = new Container();
		transcript.addChild(new Text("first", 0, 0));
		transcript.addChild(new Text("AGENT 09:07", 0, 0));
		transcript.addChild(new Text("second", 0, 0));
		assert.equal(
			await copySelection(transcript, 32, { x: 0, y: 0 }, { x: 5, y: 2 }, { scroll: true }),
			"first\nAGENT 09:07\nsecond",
		);
	});

	it("excludes Box padding while preserving source indentation", async () => {
		const box = new Box(2, 1);
		box.addChild(new Text("first\n  middle\nlast", 0, 0));
		assert.equal(await copySelection(box, 32, { x: 2, y: 1 }, { x: 5, y: 3 }), "first\n  middle\nlast");
	});

	it("preserves source tabs and trailing spaces", async () => {
		assert.equal(
			await copySelection(new Text("one  \n\ttwo", 0, 0), 32, { x: 0, y: 0 }, { x: 5, y: 1 }),
			"one  \n\ttwo",
		);
	});

	it("documents Markdown code-block presentation indent being copied", async () => {
		const component = new Markdown("```js\nfunction f() {\n  return 42;\n}\n```", 0, 0, markdownTheme);
		const lines = component.render(40).map(stripTerminalSequences);
		const first = lines.findIndex((line) => line.includes("function f()"));
		const last = lines.findIndex((line) => line.trim() === "}");
		assert.ok(first >= 0 && last > first);
		const copied = await copySelection(
			component,
			40,
			{ x: 2, y: first },
			{ x: visibleWidth(lines[last]!.trimEnd()) - 1, y: last },
		);
		assert.equal(copied, "function f() {\n    return 42;\n  }");
	});

	it("copies rendered prose rather than hidden Markdown syntax", async () => {
		const component = new Markdown("**bold** and `code`", 0, 0, markdownTheme);
		assert.equal(await copySelection(component, 32, { x: 0, y: 0 }, { x: 12, y: 0 }), "bold and code");
	});

	it("keeps wide and combining graphemes intact at selection boundaries", async () => {
		assert.equal(
			await copySelection(new Text("A\u754cB\ne\u0301Z", 0, 0), 32, { x: 2, y: 0 }, { x: 0, y: 1 }),
			"\u754cB\ne\u0301",
		);
	});

	it("copies the logical line after resizing before selection", async () => {
		assert.equal(
			await copySelection(
				new Text(longLine, 0, 0),
				32,
				{ x: 0, y: 0 },
				{ x: 31, y: 1 },
				{ resizeFrom: 80, scroll: true },
			),
			longLine,
		);
	});

	it("uses content coordinates after scrolling, without copying offscreen text", async () => {
		const source = Array.from({ length: 20 }, (_, index) => `line ${String(index).padStart(2, "0")}`).join("\n");
		assert.equal(
			await copySelection(
				new Text(source, 0, 0),
				32,
				{ x: 0, y: 0 },
				{ x: 6, y: 1 },
				{ scroll: true, scrollTop: 3 },
			),
			"line 03\nline 04",
		);
	});
});

describe("remaining cross-renderer selection-copy acceptance targets", () => {
	it.todo("omits decorative spans and rows while retaining literal identical characters in content");
	it.todo("extends logical-line and exact wrap-whitespace copying from Text to Markdown and wrappers");
	it.todo("extends Text padding exclusion to layout and decorator padding without changing source whitespace");
	it.todo("copies across message boundaries without headers or hidden thinking content");
	it.todo("extends Text selection lifecycle coverage to streaming message and Markdown integration");
	it.todo("finalizes separator/occlusion policy and extension wrapper metadata contracts");
});
