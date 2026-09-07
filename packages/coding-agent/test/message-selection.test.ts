import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	ScrollView,
	stripTerminalSequences,
	TuiAltScreen,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { MessageDecorator } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const framed: MessageDecorator = (content, context) =>
	new (class extends Container {
		private height = 0;
		constructor() {
			super();
			this.addChild(content);
		}
		override render(width: number) {
			const inner = super.render(width - 2);
			this.height = inner.length;
			if (!inner.length) return inner;
			const result = [
				"FRAME HEADER",
				...inner.map(
					(line) => `|${line}${" ".repeat(Math.max(0, width - 2 - stripTerminalSequences(line).length))}|`,
				),
				"FRAME FOOTER",
			];
			context.preserveSelection(result, inner, { row: 1, column: 1, width: width - 2 });
			return result;
		}
		override handleMouse(event: TuiMouseEvent) {
			if (event.x < 1 || event.y < 1 || event.y > this.height) return undefined;
			return super.handleMouse({
				...event,
				x: event.x - 1,
				y: event.y - 1,
				width: event.width - 2,
				height: this.height,
			});
		}
	})();

async function chat(
	component: Component,
	run: (tui: TuiAltScreen, terminal: VirtualTerminal, copied: string[]) => Promise<void>,
	width = 24,
) {
	const terminal = new VirtualTerminal(width, 40);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, false, undefined, {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	tui.setLayoutRoot(new ScrollView(component));
	try {
		tui.start();
		tui.renderNow();
		await terminal.flush();
		await run(tui, terminal, copied);
	} finally {
		tui.stop();
	}
}

function selectAll(component: Component, tui: TuiAltScreen, terminal: VirtualTerminal) {
	const height = component.render(terminal.columns).length;
	terminal.sendInput("\x1b[<0;1;1M");
	terminal.sendInput(`\x1b[<32;${terminal.columns};${height}M`);
	terminal.sendInput(`\x1b[<0;${terminal.columns};${height}m`);
	tui.renderNow();
}

for (const style of ["dark", "light"] as const)
	for (const useFrame of [false, true])
		for (const role of ["user", "assistant"] as const)
			test(`copies wrapped code through real ${role} components and OSC133 (${style}, frame=${useFrame})`, async () => {
				initTheme(style);
				const code = "\talpha beta gamma delta  \n  next\tvalue";
				const markdown = `\`\`\`text\n${code}\n\`\`\``;
				const decorators = useFrame ? [framed] : [];
				const component =
					role === "user"
						? new UserMessageComponent(markdown, undefined, 0, [], decorators, 1)
						: new AssistantMessageComponent(
								fauxAssistantMessage(markdown),
								true,
								undefined,
								"Thinking...",
								0,
								[],
								decorators,
							);
				await chat(component, async (tui, terminal, copied) => {
					selectAll(component, tui, terminal);
					expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
					expect(copied).toEqual([code]);
					expect(component.render(24).join("")).toContain("\x1b]133;A\x07");
				});
			});

for (const useFrame of [false, true])
	test(`keeps hidden thinking out of copy and preserves its click interaction (frame=${useFrame})`, async () => {
		initTheme("dark");
		const message = fauxAssistantMessage("visible answer");
		message.content.unshift({ type: "thinking", thinking: "PRIVATE THINKING" });
		const component = new AssistantMessageComponent(
			message,
			true,
			undefined,
			"Thinking...",
			0,
			[],
			useFrame ? [framed] : [],
		);
		await chat(component, async (tui, terminal, copied) => {
			selectAll(component, tui, terminal);
			expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
			expect(copied[0]).toContain("visible answer");
			expect(copied[0]).not.toContain("PRIVATE THINKING");
			const row = component.render(24).findIndex((line) => stripTerminalSequences(line).includes("Thinking..."));
			const x = useFrame ? 3 : 2;
			terminal.sendInput(`\x1b[<0;${x};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${x};${row + 1}m`);
			tui.renderNow();
			expect(component.render(24).map(stripTerminalSequences).join("\n")).toContain("PRIVATE THINKING");
			component.setHideThinkingBlock(true);
			tui.renderNow();
			expect(component.render(24).join("\n")).not.toContain("PRIVATE THINKING");
		});
	});

test("invalidates a changed streamed selection and copies the final visible answer", async () => {
	initTheme("dark");
	const component = new AssistantMessageComponent(
		fauxAssistantMessage("partial answer"),
		true,
		undefined,
		"Thinking...",
		0,
		[],
		[framed],
	);
	await chat(component, async (tui, terminal, copied) => {
		selectAll(component, tui, terminal);
		expect(tui.hasActiveSelection()).toBe(true);
		component.updateContent(fauxAssistantMessage("complete answer after streaming"), false);
		tui.renderNow();
		expect(tui.hasActiveSelection()).toBe(false);
		selectAll(component, tui, terminal);
		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied).toEqual(["complete answer after streaming"]);
	});
});
