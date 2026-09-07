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

for (const useFrame of [false, true])
	for (const reverse of [false, true])
		test(`attributes multiple chat messages without copying frames (frame=${useFrame}, reverse=${reverse})`, async () => {
			initTheme("dark");
			const decorators = useFrame ? [framed] : [];
			const timestamp = new Date(2026, 8, 7, 14, 32).getTime();
			const root = new Container();
			root.addChild(new UserMessageComponent("question", undefined, 0, [], decorators, timestamp));
			const answer = {
				...fauxAssistantMessage("```text\n\talpha beta gamma delta  \n```"),
				timestamp: timestamp + 60_000,
			};
			root.addChild(new AssistantMessageComponent(answer, true, undefined, "Thinking...", 0, [], decorators));
			await chat(root, async (tui, terminal, copied) => {
				const height = root.render(terminal.columns).length;
				if (reverse) {
					terminal.sendInput(`\x1b[<0;${terminal.columns};${height}M`);
					terminal.sendInput("\x1b[<32;1;1M");
					terminal.sendInput("\x1b[<0;1;1m");
					tui.renderNow();
				} else selectAll(root, tui, terminal);
				expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
				expect(copied).toEqual(["USER 14:32\n\nquestion\n\nAGENT 14:33\n\n\talpha beta gamma delta  "]);
			});
		});

test("partial framed endpoints omit unselected text and decoration-only endpoints add no header", async () => {
	initTheme("dark");
	const root = new Container();
	const user = new UserMessageComponent("ignore alpha", undefined, 0, [], [framed]);
	root.addChild(user);
	root.addChild(
		new AssistantMessageComponent(
			{ ...fauxAssistantMessage("beta ignore"), timestamp: Number.NaN },
			true,
			undefined,
			"Thinking...",
			0,
			[],
			[framed],
		),
	);
	await chat(root, async (tui, terminal, copied) => {
		const lines = root.render(terminal.columns).map(stripTerminalSequences);
		const first = lines.findIndex((line) => line.includes("ignore alpha")) + 1;
		const last = lines.findIndex((line) => line.includes("beta ignore")) + 1;
		terminal.sendInput(`\x1b[<0;9;${first}M`);
		terminal.sendInput(`\x1b[<32;5;${last}M`);
		terminal.sendInput(`\x1b[<0;5;${last}m`);
		tui.renderNow();
		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied.pop()).toBe("USER\n\nalpha\n\nAGENT\n\nbeta");
		const footer = user.render(terminal.columns).length;
		terminal.sendInput(`\x1b[<0;1;${footer}M`);
		terminal.sendInput(`\x1b[<32;24;${lines.length}M`);
		terminal.sendInput(`\x1b[<0;24;${lines.length}m`);
		tui.renderNow();
		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied.pop()).toBe("beta ignore");
	});
});

test("assistant text preceding tool calls retains attribution without adding terminal zones", async () => {
	initTheme("dark");
	const root = new Container();
	root.addChild(new UserMessageComponent("question", undefined, 0));
	const answer = { ...fauxAssistantMessage("answer"), timestamp: Number.NaN };
	answer.content.push({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "example" } });
	const assistant = new AssistantMessageComponent(answer, true, undefined, "Thinking...", 0);
	root.addChild(assistant);
	await chat(root, async (tui, terminal, copied) => {
		selectAll(root, tui, terminal);
		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied).toEqual(["USER\n\nquestion\n\nAGENT\n\nanswer"]);
		expect(assistant.render(24).join("")).not.toContain("\x1b]133;");
	});
});

test("missing timestamps do not invent a time and hidden thinking is never restored", async () => {
	initTheme("dark");
	const root = new Container();
	root.addChild(new UserMessageComponent("question", undefined, 0, [], [framed]));
	const answer = { ...fauxAssistantMessage("answer"), timestamp: Number.NaN };
	answer.content.unshift({ type: "thinking", thinking: "PRIVATE" });
	root.addChild(new AssistantMessageComponent(answer, true, undefined, "Thinking...", 0, [], [framed]));
	await chat(root, async (tui, terminal, copied) => {
		selectAll(root, tui, terminal);
		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied).toEqual(["USER\n\nquestion\n\nAGENT\n\nThinking...\nanswer"]);
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
