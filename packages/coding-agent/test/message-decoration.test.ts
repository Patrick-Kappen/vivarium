import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Box, Container, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { MessageDecorationContext, MessageDecorator } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "answer" }],
	api: "openai-responses",
	provider: "openai",
	model: "test",
	stopReason: "stop",
	timestamp: 123456,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

const wrap: MessageDecorator = (content) => {
	const frame = new Container();
	frame.addChild(new Text("header", 0, 0));
	const box = new Box(1, 0);
	box.addChild(content);
	frame.addChild(box);
	frame.addChild(new Text("footer", 0, 0));
	return frame;
};

describe("message decoration", () => {
	test("keeps undecorated output byte-identical when decorators decline", () => {
		initTheme("dark");
		expect(new UserMessageComponent("hello", undefined, 1, [], [() => undefined]).render(40)).toEqual(
			new UserMessageComponent("hello").render(40),
		);
		expect(
			new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [], [() => undefined]).render(40),
		).toEqual(new AssistantMessageComponent(message).render(40));
	});

	test("wraps once in order, retains OSC boundaries and passes inner Markdown width", () => {
		initTheme("dark");
		const widths: number[] = [];
		const component = new UserMessageComponent(
			"hello",
			undefined,
			1,
			[
				(markdown, context) => {
					widths.push(context.availableWidth);
					return `${markdown} transformed`;
				},
			],
			[wrap, wrap],
			123456,
		);
		const lines = component.render(40);
		expect(stripAnsi(lines.join("\n"))).toContain("hello transformed");
		expect(stripAnsi(lines.join("\n")).match(/header/g)).toHaveLength(2);
		expect(lines[0].startsWith("\x1b]133;A\x07")).toBe(true);
		expect(lines.at(-1)?.startsWith("\x1b]133;B\x07\x1b]133;C\x07")).toBe(true);
		expect(widths).toEqual([34]);
		component.setOutputPad(0);
		component.render(30);
		expect(widths.at(-1)).toBe(26);
	});

	test("exposes original timestamps and live streaming/theme metadata without changing messages", () => {
		initTheme("dark");
		const snapshots: Array<{ timestamp: number | undefined; streaming: boolean; theme: string | undefined }> = [];
		const decorate: MessageDecorator = (content, context) => ({
			render(width) {
				snapshots.push({ timestamp: context.timestamp, streaming: context.isStreaming, theme: context.theme.name });
				return content.render(width);
			},
			invalidate() {
				content.invalidate();
			},
		});
		const original = structuredClone(message);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [], [decorate]);
		component.updateContent(message, true);
		component.render(40);
		initTheme("light");
		component.invalidate();
		component.updateContent(message, false);
		component.render(40);
		expect(snapshots).toEqual([
			{ timestamp: 123456, streaming: true, theme: "dark" },
			{ timestamp: 123456, streaming: false, theme: "light" },
		]);
		expect(message).toEqual(original);
		let userContext: MessageDecorationContext | undefined;
		new UserMessageComponent(
			"hello",
			undefined,
			1,
			[],
			[
				(_content, context) => {
					userContext = context;
					return undefined;
				},
			],
			123456,
		);
		expect(userContext?.timestamp).toBe(123456);
		expect(userContext?.role).toBe("user");
		expect(userContext?.isStreaming).toBe(false);
	});

	test("preserves thinking mouse interaction and settings through the wrapper", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			{ ...message, content: [{ type: "thinking", thinking: "reasoning" }] },
			false,
			undefined,
			"Thinking...",
			1,
			[],
			[wrap],
		);
		const lines = component.render(40);
		const y = lines.findIndex((line) => stripAnsi(line).includes("reasoning"));
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 2,
			y,
			screenX: 2,
			screenY: y,
			width: 40,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("Thinking...");
		component.setHiddenThinkingLabel("Hidden");
		expect(stripAnsi(component.render(40).join("\n"))).toContain("Hidden");
		component.setHideThinkingBlock(false);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("reasoning");
	});

	test("leaves tool-bearing assistant OSC behavior unchanged", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			{
				...message,
				content: [
					{ type: "text", text: "calling tool" },
					{ type: "toolCall", id: "call", name: "read", arguments: {} },
				],
			},
			false,
			undefined,
			"Thinking...",
			1,
			[],
			[wrap],
		);
		expect(component.render(40).join("\n")).not.toContain("\x1b]133;");
	});
});
