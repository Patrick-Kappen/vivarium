import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { WorkingActivity } from "../src/modes/interactive/working-activity.ts";

interface Harness {
	handleEvent(event: AgentSessionEvent): Promise<void>;
	clearStatusIndicator(): void;
	createExtensionUIContext(): ExtensionUIContext;
	statusContainer: Container;
	pendingTools: Map<string, ToolExecutionComponent>;
}

function fixture(now: () => number): Harness {
	initTheme("dark");
	return Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		workingActivity: new WorkingActivity(now),
		workingVisible: true,
		defaultWorkingMessage: "Working",
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
				settingsManager: {
					getShowTerminalProgress: () => false,
					getShowImages: () => false,
					getImageWidthCells: () => 60,
				},
				sessionManager: { getCwd: () => "/tmp" },
			},
		},
		getRegisteredToolDefinition: () => undefined,
		ui: new TuiAltScreen(new VirtualTerminal(100, 30), false),
	}) as Harness;
}

const toolStart = (id: string): AgentSessionEvent => ({
	type: "tool_execution_start",
	toolCallId: id,
	toolName: "bash",
	args: { command: "printf ok" },
});
const toolEnd = (id: string): AgentSessionEvent => ({
	type: "tool_execution_end",
	toolCallId: id,
	toolName: "bash",
	result: { content: [{ type: "text", text: "ok" }] },
	isError: false,
});
const status = (mode: Harness) => stripTerminalSequences(mode.statusContainer.render(100).join("\n"));
afterEach(() => vi.useRealTimers());

test("silence before model output is waiting, with elapsed time rather than invented thinking", async () => {
	vi.useFakeTimers();
	let now = 0;
	const mode = fixture(() => now);
	try {
		await mode.handleEvent({ type: "agent_start" });
		await mode.handleEvent({ type: "turn_start" });
		expect(status(mode)).toContain("Waiting for model (0s)");
		now = 30_000;
		vi.advanceTimersByTime(30_000);
		expect(status(mode)).toContain("Waiting for model (30s)");
		expect(status(mode)).not.toContain("Thinking");
	} finally {
		mode.clearStatusIndicator();
	}
	expect(vi.getTimerCount()).toBe(0);
});

test("a completed tool does not remain the running activity while the next model request is quiet", async () => {
	vi.useFakeTimers();
	let now = 0;
	const mode = fixture(() => now);
	try {
		await mode.handleEvent({ type: "turn_start" });
		await mode.handleEvent(toolStart("one"));
		expect(status(mode)).toContain("Running tool");
		await mode.handleEvent(toolEnd("one"));
		expect(mode.pendingTools.size).toBe(0);
		expect(status(mode)).toContain("Tool finished");
		await mode.handleEvent({ type: "turn_start" });
		now = 45_000;
		vi.advanceTimersByTime(45_000);
		expect(status(mode)).toContain("Waiting for model (45s)");
		expect(status(mode)).not.toContain("Running tool");
		await mode.handleEvent({ type: "agent_end", messages: [], willRetry: false });
		expect(status(mode)).toBe("");
	} finally {
		mode.clearStatusIndicator();
	}
	expect(vi.getTimerCount()).toBe(0);
});

test("parallel tools remain running until the last one finishes", async () => {
	const mode = fixture(() => 0);
	try {
		await mode.handleEvent({ type: "turn_start" });
		await mode.handleEvent(toolStart("one"));
		await mode.handleEvent(toolStart("two"));
		expect(status(mode)).toContain("Running 2 tools");
		await mode.handleEvent(toolEnd("two"));
		expect(status(mode)).toContain("Running tool");
		expect(mode.pendingTools.size).toBe(1);
		await mode.handleEvent(toolEnd("one"));
		expect(status(mode)).toContain("Tool finished");
	} finally {
		mode.clearStatusIndicator();
	}
});

test("explicit extension working messages override automatic activity until reset", async () => {
	const mode = fixture(() => 0);
	try {
		await mode.handleEvent({ type: "turn_start" });
		const ui = mode.createExtensionUIContext();
		ui.setWorkingMessage("Custom progress");
		await mode.handleEvent(toolStart("one"));
		expect(status(mode)).toContain("Custom progress");
		expect(status(mode)).not.toContain("Running tool");
		ui.setWorkingMessage(undefined);
		expect(status(mode)).toContain("Running tool");
	} finally {
		mode.clearStatusIndicator();
	}
});

test("model phases follow actual stream events and end markers", () => {
	let now = 0;
	const activity = new WorkingActivity(() => now);
	const message = fauxAssistantMessage("");
	activity.update({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
	});
	expect(activity.message()).toBe("Model reasoning (0s)");
	now = 8000;
	activity.update({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "private", partial: message },
	});
	expect(activity.message()).toBe("Model reasoning (8s)");
	activity.update({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "private", partial: message },
	});
	expect(activity.message()).toBe("Waiting for model (0s)");
	activity.update({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message },
	});
	expect(activity.message()).toBe("Model response (0s)");
	activity.update({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
	});
	expect(activity.message()).toBe("Receiving tool call (0s)");
	activity.update({
		type: "message_update",
		message,
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { type: "toolCall", id: "one", name: "bash", arguments: {} },
			partial: message,
		},
	});
	expect(activity.message()).toBe("Tool call ready (0s)");
});

test("visibility and static spinner settings preserve activity and release timers", async () => {
	vi.useFakeTimers();
	let now = 0;
	const mode = fixture(() => now);
	try {
		await mode.handleEvent({ type: "turn_start" });
		const ui = mode.createExtensionUIContext();
		ui.setWorkingVisible(false);
		expect(status(mode)).toBe("");
		expect(vi.getTimerCount()).toBe(0);
		await mode.handleEvent(toolStart("one"));
		ui.setWorkingVisible(true);
		ui.setWorkingIndicator({ frames: [] });
		now = 5000;
		vi.advanceTimersByTime(5000);
		expect(status(mode)).toContain("Running tool (5s)");
		await mode.handleEvent({ type: "compaction_start", reason: "manual" });
		expect(status(mode)).toContain("Compacting context");
		await mode.handleEvent(toolEnd("one"));
		expect(status(mode)).toContain("Compacting context");
		expect(status(mode)).not.toContain("Tool finished");
	} finally {
		mode.clearStatusIndicator();
	}
	expect(vi.getTimerCount()).toBe(0);
});

test("finished hidden thinking is not presented as ongoing; custom labels remain owned by extensions", () => {
	initTheme("dark");
	const message = fauxAssistantMessage("");
	message.content.push({ type: "thinking", thinking: "PRIVATE" });
	const component = new AssistantMessageComponent(undefined, true);
	component.updateContent(message, true);
	expect(stripTerminalSequences(component.render(80).join("\n"))).toContain("Thinking...");
	component.updateContent(message, false);
	const finished = stripTerminalSequences(component.render(80).join("\n"));
	expect(finished).toContain("Thinking (hidden)");
	expect(finished).not.toContain("PRIVATE");
	component.setHiddenThinkingLabel("Custom reasoning");
	expect(stripTerminalSequences(component.render(80).join("\n"))).toContain("Custom reasoning");
});
