import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { checkProviderAuth, createAuthCheckModelRuntime, getProviderCredential } from "../src/cli/auth-check.ts";
import { parseAuthCommand } from "../src/cli/auth-command.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { clearApiKeyCache } from "../src/core/provider-composer.ts";
import { main } from "../src/main.ts";

const tempDir = join(tmpdir(), `pi-test-auth-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalAgentDir = process.env[ENV_AGENT_DIR];

async function createRuntime(credentials: AuthStorage | ReadOnlyAuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

describe("auth check command", () => {
	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		process.exitCode = undefined;
		clearApiKeyCache();
		vi.restoreAllMocks();
	});

	test("reports a configured provider as ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
			source: "stored",
		});
	});

	test("reports the active credential source without exposing credential values", async () => {
		process.env.OPENAI_API_KEY = "synthetic-environment-key";
		clearApiKeyCache();

		const environmentRuntime = await createRuntime(AuthStorage.inMemory());
		const environmentResult = await checkProviderAuth(parseArgs(["--provider", "openai"]), environmentRuntime);
		expect(environmentResult).toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
			source: "environment",
		});
		expect(JSON.stringify(environmentResult)).not.toContain("synthetic-environment-key");

		const storedRuntime = await createRuntime(
			AuthStorage.inMemory({ openai: { type: "api_key", key: "synthetic-stored-key" } }),
		);
		const storedResult = await checkProviderAuth(parseArgs(["--provider", "openai"]), storedRuntime);
		expect(storedResult).toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
			source: "stored",
		});
		expect(JSON.stringify(storedResult)).not.toContain("synthetic-stored-key");
		expect(JSON.stringify(storedResult)).not.toContain("synthetic-environment-key");

		await storedRuntime.logout("openai");
		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), storedRuntime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
			source: "environment",
		});
	});

	test("prints the source only in JSON while preserving plain status output", async () => {
		process.env.OPENAI_API_KEY = "synthetic-cli-environment-key";
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
		clearApiKeyCache();
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			writes.push(String(chunk));
			return true;
		});

		await main(["auth", "check", "--provider", "openai", "--no-refresh", "--json"]);
		const json = JSON.parse(writes.join(""));
		expect(json).toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
			source: "environment",
		});
		expect(writes.join("")).not.toContain("synthetic-cli-environment-key");
		expect(existsSync(join(tempDir, "agent", "auth.json"))).toBe(false);

		writes.length = 0;
		await main(["auth", "check", "--provider", "openai", "--no-refresh"]);
		expect(writes.join("")).toBe("ready\n");
	});

	test("resolves the provider from --model", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--model", "openai/gpt-5.5"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
			source: "stored",
		});
		await expect(
			checkProviderAuth(parseArgs(["--provider", "openai", "--model", "gpt-5.5"]), runtime),
		).resolves.toMatchObject({ status: "ready", provider: "openai" });
	});

	test("reads credentials without refreshing OAuth when requested", async () => {
		const apiCredentials = AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } });
		const apiRuntime = await createRuntime(apiCredentials);
		await expect(getProviderCredential("openai", apiRuntime, apiCredentials, { refresh: false })).resolves.toBe(
			"test-key",
		);

		const credentials = AuthStorage.inMemory({
			"openai-codex": { type: "oauth", access: "old-token", refresh: "refresh-token", expires: 0 },
		});
		const oauthRuntime = await createRuntime(credentials);
		const oauth = oauthRuntime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		const refresh = vi.fn(oauth.refresh);
		oauth.refresh = refresh;

		await expect(getProviderCredential("openai-codex", oauthRuntime, credentials, { refresh: false })).resolves.toBe(
			"old-token",
		);
		expect(refresh).not.toHaveBeenCalled();
	});

	test("refreshes OAuth by default", async () => {
		const credentials = AuthStorage.inMemory({
			"openai-codex": { type: "oauth", access: "old-token", refresh: "refresh-token", expires: 0 },
		});
		const runtime = await createRuntime(credentials);
		const oauth = runtime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		const refresh = vi.fn(async () => ({
			type: "oauth" as const,
			access: "fresh-token",
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
		}));
		oauth.refresh = refresh;

		await expect(
			checkProviderAuth(parseArgs(["--provider", "openai-codex"]), runtime, { refresh: true }),
		).resolves.toMatchObject({
			status: "ready",
		});
		expect(refresh).toHaveBeenCalledOnce();
	});

	test("reports an unknown provider as not ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());

		await expect(checkProviderAuth(parseArgs(["--provider", "not-installed"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "not-installed",
			reason: "provider_not_found",
		});
	});

	test("does not treat an unresolved stored environment reference as configured", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "$MISSING_AUTH_CHECK_KEY" } }), "utf-8");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "openai",
			reason: "credentials_not_configured",
		});
	});

	test("reports malformed auth state as invalid", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, "{invalid-json", "utf-8");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "invalid",
			provider: "openai",
			reason: "invalid_state",
		});
	});

	test("does not create an auth file or its parent directory", async () => {
		const authPath = join(tempDir, "agent", "auth.json");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toMatchObject({
			status: "not_ready",
			reason: "credentials_not_configured",
		});
		expect(existsSync(authPath)).toBe(false);
		expect(existsSync(join(tempDir, "agent"))).toBe(false);
	});

	test("accepts optional JSON output, credential output, and --no-refresh", () => {
		expect(parseAuthCommand(["auth", "check", "--provider", "openai"])).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: false,
			credentials: false,
			noRefresh: false,
		});
		expect(
			parseAuthCommand(["auth", "check", "--json", "--credentials", "--no-refresh", "--provider", "openai"]),
		).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: true,
			credentials: true,
			noRefresh: true,
		});
	});

	test("creates an auth-check runtime without catalog storage", async () => {
		const runtime = await createAuthCheckModelRuntime(AuthStorage.inMemory());
		expect(runtime.getProvider("openai")).toBeDefined();
	});
});
