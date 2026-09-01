import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir, getModelsPath, getSettingsPath } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime, resolveModelsStorePath } from "../src/core/model-runtime.ts";
import * as modelsStoreModule from "../src/core/models-store.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// =============================================================================
// Managed configuration inputs (Vivarium)
// =============================================================================
// Covers the VIVARIUM_MANAGED / VIVARIUM_SETTINGS_PATH / VIVARIUM_MODELS_PATH
// contract: explicit read-only settings.json and models.json inputs, with the
// agent directory remaining the writable location for runtime state.

const ENV_MANAGED = "VIVARIUM_MANAGED";
const ENV_SETTINGS_PATH = "VIVARIUM_SETTINGS_PATH";
const ENV_MODELS_PATH = "VIVARIUM_MODELS_PATH";
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

const originalEnv: Record<string, string | undefined> = {
	[ENV_MANAGED]: process.env[ENV_MANAGED],
	[ENV_SETTINGS_PATH]: process.env[ENV_SETTINGS_PATH],
	[ENV_MODELS_PATH]: process.env[ENV_MODELS_PATH],
	[ENV_AGENT_DIR]: process.env[ENV_AGENT_DIR],
};

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

function restoreEnv(): void {
	for (const [name, value] of Object.entries(originalEnv)) {
		setEnv(name, value);
	}
}

describe("managed configuration inputs", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "managed-config-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		setEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		restoreEnv();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("config path selection", () => {
		it("selects explicit settings.json and models.json inputs independently of the agent dir", () => {
			const settingsPath = join(tempDir, "managed-settings.json");
			const modelsPath = join(tempDir, "managed-models.json");
			setEnv(ENV_SETTINGS_PATH, settingsPath);
			setEnv(ENV_MODELS_PATH, modelsPath);

			expect(getSettingsPath()).toBe(settingsPath);
			expect(getModelsPath()).toBe(modelsPath);
			expect(getSettingsPath()).not.toBe(join(getAgentDir(), "settings.json"));
		});

		it("falls back to the agent dir when the Vivarium variables are absent", () => {
			setEnv(ENV_SETTINGS_PATH, undefined);
			setEnv(ENV_MODELS_PATH, undefined);

			expect(getSettingsPath()).toBe(join(agentDir, "settings.json"));
			expect(getModelsPath()).toBe(join(agentDir, "models.json"));
		});
	});

	describe("managed settings input", () => {
		function createManagedSettings(): string {
			const path = join(tempDir, "managed-settings.json");
			writeFileSync(path, JSON.stringify({ theme: "dark", defaultModel: "baseline-model" }, null, 2));
			return path;
		}

		it("rejects a missing explicit settings input without creating it", () => {
			const settingsPath = join(tempDir, "missing-settings", "settings.json");
			setEnv(ENV_SETTINGS_PATH, settingsPath);
			setEnv(ENV_MANAGED, "1");

			expect(() => SettingsManager.create(cwd, agentDir)).toThrow(
				`Explicit settings input does not exist: ${settingsPath}`,
			);
			expect(existsSync(settingsPath)).toBe(false);
			expect(existsSync(dirname(settingsPath))).toBe(false);
		});

		it("allows the implicit agent-dir settings file to be absent", () => {
			setEnv(ENV_SETTINGS_PATH, undefined);

			const manager = SettingsManager.create(cwd, agentDir);

			expect(manager.getGlobalSettings()).toEqual({});
			expect(manager.drainErrors()).toEqual([]);
			expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		});

		it("loads global settings from the managed settings path", () => {
			const settingsPath = createManagedSettings();
			setEnv(ENV_SETTINGS_PATH, settingsPath);

			const manager = SettingsManager.create(cwd, agentDir);

			expect(manager.getGlobalSettings().theme).toBe("dark");
			expect(manager.getDefaultModel()).toBe("baseline-model");
		});

		it("loads managed settings without creating a lock beside a read-only input", () => {
			const managedDir = join(tempDir, "read-only-store");
			mkdirSync(managedDir);
			const settingsPath = join(managedDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
			setEnv(ENV_SETTINGS_PATH, settingsPath);
			setEnv(ENV_MANAGED, "1");
			chmodSync(managedDir, 0o555);

			try {
				const manager = SettingsManager.create(cwd, agentDir);
				expect(manager.getGlobalSettings().theme).toBe("dark");
				expect(manager.drainErrors()).toEqual([]);
				expect(existsSync(`${settingsPath}.lock`)).toBe(false);
			} finally {
				chmodSync(managedDir, 0o755);
			}
		});

		it("persists changelog bookkeeping beside runtime state without changing managed settings", async () => {
			const settingsPath = createManagedSettings();
			writeFileSync(
				settingsPath,
				JSON.stringify({ theme: "dark", defaultModel: "baseline-model", lastChangelogVersion: "0.84.3" }, null, 2),
			);
			const managedInputBefore = readFileSync(settingsPath, "utf-8");
			const statePath = join(agentDir, "managed-state.json");
			setEnv(ENV_SETTINGS_PATH, settingsPath);
			setEnv(ENV_MANAGED, "1");

			const manager = SettingsManager.create(cwd, agentDir);
			expect(manager.getLastChangelogVersion()).toBe("0.84.3");
			expect(existsSync(statePath)).toBe(false);

			manager.setLastChangelogVersion("0.84.4");
			await manager.flush();

			expect(readFileSync(settingsPath, "utf-8")).toBe(managedInputBefore);
			expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({ lastChangelogVersion: "0.84.4" });
			expect(existsSync(`${settingsPath}.lock`)).toBe(false);
			expect(existsSync(`${statePath}.lock`)).toBe(false);
			expect(manager.drainErrors()).toEqual([]);

			const reloaded = SettingsManager.create(cwd, agentDir);
			expect(reloaded.getLastChangelogVersion()).toBe("0.84.4");
			expect(reloaded.getDefaultModel()).toBe("baseline-model");
			expect(reloaded.drainErrors()).toEqual([]);
		});

		it.each([
			["malformed JSON", '{"lastChangelogVersion":'],
			["an operator setting field", '{"defaultModel":"injected-model"}'],
		])("preserves managed bookkeeping state containing %s", async (_case, invalidState) => {
			const settingsPath = createManagedSettings();
			const statePath = join(agentDir, "managed-state.json");
			writeFileSync(statePath, invalidState);
			setEnv(ENV_SETTINGS_PATH, settingsPath);
			setEnv(ENV_MANAGED, "1");

			const manager = SettingsManager.create(cwd, agentDir);
			expect(manager.getLastChangelogVersion()).toBeUndefined();
			expect(manager.getDefaultModel()).toBe("baseline-model");
			const errors = manager.drainErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0]?.path).toBe(statePath);

			manager.setLastChangelogVersion("0.84.4");
			await manager.flush();

			expect(readFileSync(statePath, "utf-8")).toBe(invalidState);
		});

		it("keeps implicit agent-dir global settings read-only in managed mode", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const contents = '{"theme":"dark","defaultModel":"baseline-model"}\n';
			writeFileSync(settingsPath, contents);
			setEnv(ENV_SETTINGS_PATH, undefined);
			setEnv(ENV_MANAGED, "1");

			const manager = SettingsManager.create(cwd, agentDir);
			expect(manager.getDefaultModel()).toBe("baseline-model");
			manager.setDefaultModel("session-model");
			await manager.flush();

			expect(manager.getDefaultModel()).toBe("session-model");
			expect(readFileSync(settingsPath, "utf8")).toBe(contents);
			expect(existsSync(`${settingsPath}.lock`)).toBe(false);
			expect(manager.drainErrors()).toMatchObject([
				{
					scope: "global",
					path: settingsPath,
				},
			]);
		});

		it("keeps a caller-supplied global settings path read-only in managed mode", async () => {
			const envSettingsPath = createManagedSettings();
			const callerSettingsPath = join(tempDir, "caller-settings.json");
			const callerContents = '{"theme":"light","defaultModel":"caller-model"}\n';
			writeFileSync(callerSettingsPath, callerContents);
			setEnv(ENV_SETTINGS_PATH, envSettingsPath);
			setEnv(ENV_MANAGED, "1");

			const manager = SettingsManager.create(cwd, agentDir, { settingsPath: callerSettingsPath });
			expect(manager.getGlobalSettings().theme).toBe("light");
			expect(manager.getDefaultModel()).toBe("caller-model");
			manager.setDefaultModel("session-model");
			await manager.flush();

			expect(readFileSync(callerSettingsPath, "utf8")).toBe(callerContents);
			expect(JSON.parse(readFileSync(envSettingsPath, "utf8"))).toMatchObject({ defaultModel: "baseline-model" });
			expect(existsSync(`${callerSettingsPath}.lock`)).toBe(false);
			expect(manager.drainErrors()).toMatchObject([
				{
					scope: "global",
					path: callerSettingsPath,
				},
			]);
		});

		it("refuses to persist saved model and thinking defaults into managed settings", async () => {
			const settingsPath = createManagedSettings();
			setEnv(ENV_SETTINGS_PATH, settingsPath);
			setEnv(ENV_MANAGED, "1");

			const manager = SettingsManager.create(cwd, agentDir);
			manager.setDefaultModel("session-model");
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory session state still reflects the selection.
			expect(manager.getDefaultModel()).toBe("session-model");
			expect(manager.getDefaultThinkingLevel()).toBe("high");

			// The managed input file is untouched.
			const persisted = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
				theme?: string;
				defaultModel?: string;
				defaultThinkingLevel?: string;
			};
			expect(persisted.theme).toBe("dark");
			expect(persisted.defaultModel).toBe("baseline-model");
			expect(persisted.defaultThinkingLevel).toBeUndefined();

			// No settings.json was created in the writable agent directory either.
			expect(existsSync(join(agentDir, "settings.json"))).toBe(false);

			// The refusal is reported as a settings error with the managed path.
			const errors = manager.drainErrors();
			expect(errors.length).toBeGreaterThan(0);
			for (const error of errors) {
				expect(error.scope).toBe("global");
				expect(error.path).toBe(settingsPath);
				expect(error.error.message).toContain("read-only managed configuration input");
			}
		});

		it("keeps the managed settings input writable when VIVARIUM_MANAGED is not set", async () => {
			const settingsPath = createManagedSettings();
			setEnv(ENV_SETTINGS_PATH, settingsPath);
			setEnv(ENV_MANAGED, undefined);

			const manager = SettingsManager.create(cwd, agentDir);
			manager.setDefaultModel("selected-model");
			await manager.flush();

			const persisted = JSON.parse(readFileSync(settingsPath, "utf-8")) as { defaultModel?: string };
			expect(persisted.defaultModel).toBe("selected-model");
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("managed models input", () => {
		function createManagedModels(): string {
			const path = join(tempDir, "managed-models.json");
			writeFileSync(
				path,
				JSON.stringify({
					providers: {
						"managed-test": {
							baseUrl: "http://localhost:9999/v1",
							api: "openai-completions",
							apiKey: "managed-placeholder",
							models: [{ id: "managed-model" }],
						},
					},
				}),
			);
			return path;
		}

		it("rejects a missing explicit models input without creating it", async () => {
			const modelsPath = join(tempDir, "missing-models", "models.json");
			setEnv(ENV_MODELS_PATH, modelsPath);
			setEnv(ENV_MANAGED, "1");

			await expect(ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false })).rejects.toThrow(
				`Explicit models input does not exist: ${modelsPath}`,
			);
			expect(existsSync(modelsPath)).toBe(false);
			expect(existsSync(dirname(modelsPath))).toBe(false);
		});

		it("allows the implicit agent-dir models file to be absent", async () => {
			setEnv(ENV_MODELS_PATH, undefined);

			const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });

			expect(runtime.getError()).toBeUndefined();
			expect(existsSync(join(agentDir, "models.json"))).toBe(false);
		});

		it("fails closed when an explicit models input disappears before refresh", async () => {
			const modelsPath = createManagedModels();
			setEnv(ENV_MODELS_PATH, modelsPath);
			const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
			rmSync(modelsPath);

			await expect(runtime.refresh({ allowNetwork: false })).rejects.toThrow(
				`Explicit models input does not exist: ${modelsPath}`,
			);
			expect(existsSync(modelsPath)).toBe(false);
		});

		it("loads the model configuration from the managed models path", async () => {
			const modelsPath = createManagedModels();
			setEnv(ENV_MODELS_PATH, modelsPath);

			const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });

			expect(runtime.getModel("managed-test", "managed-model")?.id).toBe("managed-model");
			expect(runtime.getError()).toBeUndefined();
		});

		it("keeps the models-store cache in the writable agent dir, not next to the managed input", async () => {
			const modelsPath = createManagedModels();
			setEnv(ENV_MODELS_PATH, modelsPath);

			expect(resolveModelsStorePath(modelsPath, true)).toBe(join(agentDir, "models-store.json"));
			expect(resolveModelsStorePath(modelsPath, false)).toBe(join(dirname(modelsPath), "models-store.json"));

			const storeSpy = vi.spyOn(modelsStoreModule, "FileModelsStore");
			let constructedPaths: string[];
			try {
				await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
				constructedPaths = storeSpy.mock.calls.map((args) => args[0]).filter((p): p is string => p !== undefined);
			} finally {
				storeSpy.mockRestore();
			}

			expect(constructedPaths.length).toBeGreaterThan(0);
			expect(constructedPaths).toContain(join(agentDir, "models-store.json"));
			expect(constructedPaths).not.toContain(join(dirname(modelsPath), "models-store.json"));
		});

		it("keeps the cache in the agent dir even when callers pass the env-selected models path explicitly", async () => {
			const modelsPath = createManagedModels();
			setEnv(ENV_MODELS_PATH, modelsPath);

			// agent-session-services and the SDK resolve the env path and pass it
			// as an explicit modelsPath; the managed flag follows the effective path.
			const storeSpy = vi.spyOn(modelsStoreModule, "FileModelsStore");
			let constructedPaths: string[];
			try {
				await ModelRuntime.create({ modelsPath, refreshOnCreate: false, allowModelNetwork: false });
				constructedPaths = storeSpy.mock.calls.map((args) => args[0]).filter((p): p is string => p !== undefined);
			} finally {
				storeSpy.mockRestore();
			}

			expect(constructedPaths.length).toBeGreaterThan(0);
			expect(constructedPaths).toContain(join(agentDir, "models-store.json"));
			expect(constructedPaths).not.toContain(join(dirname(modelsPath), "models-store.json"));
		});

		it("keeps auth.json writable in the agent dir for runtime credentials", async () => {
			setEnv(ENV_MANAGED, "1");
			setEnv(ENV_MODELS_PATH, createManagedModels());

			const auth = AuthStorage.create(join(agentDir, "auth.json"));
			await auth.modify("managed-test", async () => ({
				providerId: "managed-test",
				type: "api_key",
				key: "secret-key",
			}));

			expect(existsSync(join(agentDir, "auth.json"))).toBe(true);
			const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")) as {
				"managed-test"?: { key?: string };
			};
			expect(stored["managed-test"]?.key).toBe("secret-key");
		});
	});

	describe("managed metadata commands", () => {
		it("reads explicit inputs without changing managed or runtime state", () => {
			const settingsPath = join(tempDir, "metadata-settings.json");
			const modelsPath = join(tempDir, "metadata-models.json");
			const settingsContents = '{"theme":"dark"}\n';
			const modelsContents = '{"providers":{}}\n';
			writeFileSync(settingsPath, settingsContents);
			writeFileSync(modelsPath, modelsContents);

			const result = spawnSync(
				process.execPath,
				[
					"--import",
					resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs"),
					resolve(__dirname, "../src/cli.ts"),
					"--version",
				],
				{
					cwd,
					env: {
						...process.env,
						[ENV_AGENT_DIR]: agentDir,
						[ENV_SETTINGS_PATH]: settingsPath,
						[ENV_MODELS_PATH]: modelsPath,
						[ENV_MANAGED]: "1",
						PI_OFFLINE: "1",
						TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
					},
					encoding: "utf8",
				},
			);

			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
			expect(result.stderr).toBe("");
			expect(readFileSync(settingsPath, "utf8")).toBe(settingsContents);
			expect(readFileSync(modelsPath, "utf8")).toBe(modelsContents);
			expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
			expect(existsSync(join(agentDir, "managed-state.json"))).toBe(false);
			expect(existsSync(`${settingsPath}.lock`)).toBe(false);
			expect(existsSync(`${modelsPath}.lock`)).toBe(false);
		});
	});

	describe("managed-mode system prompt discovery", () => {
		it("does not discover global SYSTEM.md or APPEND_SYSTEM.md from the agent dir", async () => {
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Global append instructions.");
			setEnv(ENV_MANAGED, "1");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBeUndefined();
			expect(loader.getSystemPromptSource()).toBeUndefined();
			expect(loader.getAppendSystemPrompt()).toEqual([]);
			expect(loader.getAppendSystemPromptSources()).toEqual([]);
		});

		it("still discovers a trusted project SYSTEM.md in managed mode", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "Project system prompt.");
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			setEnv(ENV_MANAGED, "1");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Project system prompt.");
			expect(loader.getSystemPromptSource()).toEqual({ path: join(piDir, "SYSTEM.md") });
		});

		it("discovers agent-dir SYSTEM.md when Vivarium variables are absent", async () => {
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			setEnv(ENV_MANAGED, undefined);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Global system prompt.");
			expect(loader.getSystemPromptSource()).toEqual({ path: join(agentDir, "SYSTEM.md") });
		});
	});
});
