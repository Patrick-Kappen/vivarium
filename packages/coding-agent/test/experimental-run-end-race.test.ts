import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@earendil-works/pi-client";
import { expect, test, vi } from "vitest";
import { runClient } from "../src/experimental/client.ts";
import * as clientRuntime from "../src/experimental/client-runtime.ts";
import * as processRuntime from "../src/experimental/process.ts";
import { startServer } from "../src/experimental/server.ts";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import { Transcript } from "../src/experimental/services/transcript.ts";
import { configureExperimentalWorkerModel, createExperimentalSessions } from "./experimental-session-support.ts";

// PR #17 / CI run 34093833180: RPC completion must not discard queued terminal events.
for (const outcome of ["success", "callback-error", "disconnect"] as const)
	test(`drains terminal delivery after the prompt response (${outcome})`, async () => {
		const directory = await mkdtemp("/tmp/pi-run-end-race-");
		const trace: string[] = [];
		const events: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let received!: () => void;
		const terminalReceived = new Promise<void>((resolve) => {
			received = resolve;
		});
		const spawn = processRuntime.spawnInternalProcess;
		vi.spyOn(processRuntime, "spawnInternalProcess").mockImplementation((role, args, options) =>
			spawn(
				role,
				args,
				role === "session-worker"
					? { ...options, entryUrl: new URL("fixtures/faux-session-worker.ts", import.meta.url) }
					: options,
			),
		);
		const subscribe = Client.prototype.subscribeService;
		vi.spyOn(Client.prototype, "subscribeService").mockImplementation(function (
			this: Client,
			target,
			serviceId,
			mode,
			listener,
			signal,
		) {
			return subscribe.call(
				this,
				target,
				serviceId,
				mode,
				async (update) => {
					// Only synthetic fixture data is inspected; the real framed transport remains in use.
					if (serviceId === Transcript.id && JSON.stringify(update).includes('"run_end"')) {
						trace.push("client:decoded run_end; hold queued service delivery");
						received();
						await gate;
						trace.push("client:release run_end to service replica");
					}
					await listener(update);
				},
				signal,
			);
		});
		const request = Client.prototype.request;
		vi.spyOn(Client.prototype, "request").mockImplementation(async function (this: Client, target, call, signal) {
			const result = await request.call(this, target, call, signal);
			if (call.serviceId === AgentController.id && call.member === "prompt") {
				trace.push("client:prompt RPC response received");
				// Ensure the terminal event is received and queued before exposing the RPC result.
				await terminalReceived;
				trace.push("client:prompt RPC response exposed");
				setImmediate(() => {
					if (outcome === "disconnect") this.disconnect("test disconnect before terminal delivery");
					release();
				});
			}
			return result;
		});
		const activate = clientRuntime.activateBuiltinClientServices;
		vi.spyOn(clientRuntime, "activateBuiltinClientServices").mockImplementation(async (...args) => {
			const services = await activate(...args);
			const state = services.transcript.state;
			return {
				...services,
				transcript: {
					state: {
						get value() {
							return state.value;
						},
						subscribe(listener) {
							const unsubscribe = state.subscribe(listener);
							return () => {
								trace.push("runClient:unsubscribe application transcript listener");
								unsubscribe();
							};
						},
					},
				},
			};
		});
		let server: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			const agentDir = join(directory, "agent");
			await configureExperimentalWorkerModel(agentDir);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
			await createExperimentalSessions(join(agentDir, "experimental", "sessions"), ["demo-1"]);
			server = await startServer({ provider: "anthropic", model: "claude-sonnet-4-5", directory });
			const pending = runClient(
				{ command: "client", sessionId: "demo-1", prompt: "question" },
				{
					directory,
					async onEvent(event) {
						await Promise.resolve();
						if (outcome === "callback-error" && event.type === "run_end")
							throw new Error("test callback failure");
						events.push(event.type);
						trace.push(`application:${event.type}`);
					},
				},
			);
			if (outcome === "disconnect") await expect(pending).rejects.toThrow(/disconnect|detached/i);
			else if (outcome === "callback-error") await expect(pending).rejects.toThrow("test callback failure");
			else {
				const result = await pending;
				expect(result).toMatchObject({ kind: "prompted", text: "deterministic remote answer" });
				expect(events).toContain("run_end");
				expect(trace.indexOf("application:run_end")).toBeLessThan(
					trace.indexOf("runClient:unsubscribe application transcript listener"),
				);
			}
			expect(trace).toContain("client:decoded run_end; hold queued service delivery");
		} finally {
			release();
			await server?.close();
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	});
