import { type Component, Text } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI, MessageDecorator } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

// Registration does not use the bundled extension-import namespaces. Avoid loading the entire engine barrel.
vi.mock("@earendil-works/pi-agent-core", () => ({}));
vi.mock("../src/index.ts", () => ({}));

test("registers one decorator per extension, chains in load order and isolates factory failures", async () => {
	initTheme("dark");
	const runtime = createExtensionRuntime();
	const events = createEventBus();
	const calls: string[] = [];
	let api: ExtensionAPI | undefined;
	const first = await loadExtensionFromFactory(
		(pi) => {
			api = pi;
			pi.registerMessageDecorator(() => {
				throw new Error("replaced registration");
			});
			pi.registerMessageDecorator((content) => {
				calls.push("first");
				return content;
			});
		},
		process.cwd(),
		events,
		runtime,
		"<first>",
	);
	const second = await loadExtensionFromFactory(
		(pi) => {
			pi.registerMessageDecorator(() => {
				calls.push("second");
				throw new Error("broken factory");
			});
		},
		process.cwd(),
		events,
		runtime,
		"<second>",
	);
	const third = await loadExtensionFromFactory(
		(pi) => {
			pi.registerMessageDecorator((content) => {
				calls.push("third");
				return content;
			});
		},
		process.cwd(),
		events,
		runtime,
		"<third>",
	);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner(
		[first, second, third],
		runtime,
		process.cwd(),
		SessionManager.inMemory(),
		registry,
	);
	const errors: string[] = [];
	runner.onError((error) => errors.push(`${error.extensionPath}: ${error.error}`));
	const content = new Text("content", 0, 0);
	const context = { role: "user" as const, timestamp: 1, isStreaming: false, theme };
	let decorated: Component = content;
	for (const decorate of runner.getMessageDecorators()) {
		decorated = decorate(decorated, context) ?? decorated;
	}
	expect(decorated).toBe(content);
	expect(calls).toEqual(["first", "second", "third"]);
	expect(errors).toEqual(["<second>: broken factory"]);
	expect(runner.getMessageRenderer("user")).toBeUndefined();
	expect(runner.getMarkdownTransformers()).toEqual([]);
	const replacement = new ExtensionRunner(
		[],
		createExtensionRuntime(),
		process.cwd(),
		SessionManager.inMemory(),
		registry,
	);
	expect(replacement.getMessageDecorators()).toEqual([]);
	runner.invalidate();
	const passthrough: MessageDecorator = (component) => component;
	expect(() => api?.registerMessageDecorator(passthrough)).toThrow(/stale/);
});
