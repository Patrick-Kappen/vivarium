import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { WorkingActivity } from "../src/modes/interactive/working-activity.ts";

interface Harness {
	handleEvent(event: AgentSessionEvent): Promise<void>;
	streamingComponent?: AssistantMessageComponent;
	chatContainer: Container;
	clearStatusIndicator(): void;
}

function fixture(): Harness {
	initTheme("dark");
	return Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		workingActivity: new WorkingActivity(),
		workingVisible: false,
		hideThinkingBlock: true,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 0,
		footer: { invalidate() {} },
		pendingTools: new Map(),
		statusContainer: new Container(),
		chatContainer: new Container(),
		defaultEditor: { setWorkingStatusIndicator() {} },
		editor: {},
		options: { tuiMode: "fullscreen" },
		runtimeHost: {
			session: {
				isStreaming: true,
				retryAttempt: 0,
				extensionRunner: { getMessageDecorators: () => [] },
				settingsManager: {
					getShowTerminalProgress: () => false,
					getShowImages: () => false,
					getImageWidthCells: () => 60,
				},
				sessionManager: { getCwd: () => "/tmp" },
			},
		},
		getRegisteredToolDefinition: () => undefined,
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		maybeShowAssistantDiagnostics() {},
		maybeShowCacheMissNotice() {},
		ui: new TuiAltScreen(new VirtualTerminal(80, 30), false),
	}) as Harness;
}

for (const afterTool of [false, true])
	test(`hidden thinking appears at its declared start, before any text (after tool=${afterTool})`, async () => {
		const mode = fixture();
		try {
			if (afterTool) {
				const previous = fauxAssistantMessage("");
				previous.content = [{ type: "thinking", thinking: "earlier private reasoning" }];
				await mode.handleEvent({ type: "message_start", message: previous });
				await mode.handleEvent({ type: "message_end", message: previous });
				await mode.handleEvent({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: {} });
				await mode.handleEvent({
					type: "tool_execution_end",
					toolCallId: "call",
					toolName: "bash",
					result: { content: [] },
					isError: false,
				});
			}
			await mode.handleEvent({ type: "turn_start" });
			const message = fauxAssistantMessage("");
			message.content = [];
			await mode.handleEvent({ type: "message_start", message });
			const component = mode.streamingComponent!;
			expect(component.render(80)).toEqual([]);
			message.content = [{ type: "thinking", thinking: "" }];
			await mode.handleEvent({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
			});
			expect(stripTerminalSequences(component.render(80).join("\n"))).toContain("Thinking...");
			component.invalidate();
			expect(stripTerminalSequences(component.render(40).join("\n"))).toContain("Thinking...");
			message.content = [{ type: "thinking", thinking: "private streamed reasoning" }];
			await mode.handleEvent({
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "private streamed reasoning",
					partial: message,
				},
			});
			const streaming = stripTerminalSequences(component.render(80).join("\n"));
			expect(streaming).toContain("Thinking...");
			expect(streaming).not.toContain("private streamed reasoning");
			await mode.handleEvent({ type: "message_end", message });
			expect(stripTerminalSequences(component.render(80).join("\n"))).toContain("Thinking (hidden)");
		} finally {
			mode.clearStatusIndicator();
		}
	});

test("client visibility toggles apply immediately to an active empty thinking block", () => {
	initTheme("dark");
	const component = new AssistantMessageComponent(undefined, false);
	const message = fauxAssistantMessage("");
	message.content = [{ type: "thinking", thinking: "" }];
	component.updateContent(message, true, { contentIndex: 0, finished: false });
	expect(component.render(80)).toEqual([]);
	component.setHideThinkingBlock(true);
	expect(stripTerminalSequences(component.render(80).join("\n"))).toContain("Thinking...");
	component.setHideThinkingBlock(false);
	expect(component.render(80)).toEqual([]);
	component.updateContent(message, false);
	component.setHideThinkingBlock(true);
	expect(component.render(80)).toEqual([]);
});

test("independently started blocks remain active until their own end events", () => {
	initTheme("dark");
	const component = new AssistantMessageComponent(undefined, true);
	const message = fauxAssistantMessage("");
	message.content = [
		{ type: "thinking", thinking: "" },
		{ type: "text", text: "separator" },
		{ type: "thinking", thinking: "" },
	];
	component.updateContent(message, true, { contentIndex: 0, finished: false });
	component.updateContent(message, true, { contentIndex: 2, finished: false });
	expect(stripTerminalSequences(component.render(80).join("\n")).match(/Thinking\.\.\./g)).toHaveLength(2);
	component.updateContent(message, true, { contentIndex: 0, finished: true });
	expect(stripTerminalSequences(component.render(80).join("\n")).match(/Thinking\.\.\./g)).toHaveLength(1);
});

test("clicking an empty thinking run keeps its override when an earlier empty run gains text", () => {
	initTheme("dark");
	const component = new AssistantMessageComponent(undefined, true);
	const message = fauxAssistantMessage("");
	message.content = [
		{ type: "thinking", thinking: "" },
		{ type: "text", text: "separator" },
		{ type: "thinking", thinking: "" },
	];
	component.updateContent(message, true, { contentIndex: 2, finished: false });
	const lines = component.render(80);
	const row = lines.findIndex((line) => stripTerminalSequences(line).includes("Thinking..."));
	expect(row).toBeGreaterThanOrEqual(0);
	expect(
		component.handleMouse({
			type: "click",
			button: "left",
			x: 1,
			y: row,
			screenX: 1,
			screenY: row,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		})?.handled,
	).toBe(true);
	message.content = [
		{ type: "thinking", thinking: "earlier private" },
		{ type: "text", text: "separator" },
		{ type: "thinking", thinking: "chosen visible" },
	];
	component.updateContent(message, true);
	const rendered = stripTerminalSequences(component.render(80).join("\n"));
	expect(rendered).not.toContain("earlier private");
	expect(rendered).toContain("chosen visible");
});

test("an empty reasoning block is not retained after its end or in history", async () => {
	const mode = fixture();
	try {
		const message = fauxAssistantMessage("");
		message.content = [{ type: "thinking", thinking: "" }];
		await mode.handleEvent({ type: "message_start", message });
		const component = mode.streamingComponent!;
		await mode.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
		});
		expect(stripTerminalSequences(component.render(80).join("\n"))).toContain("Thinking...");
		await mode.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "", partial: message },
		});
		expect(component.render(80)).toEqual([]);
		await mode.handleEvent({ type: "message_end", message });
		expect(component.render(80)).toEqual([]);
	} finally {
		mode.clearStatusIndicator();
	}
});
