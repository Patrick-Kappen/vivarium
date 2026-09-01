import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAuthCommand } from "../src/cli/auth-command.ts";
import { requiresManagedAuthMigration, resolveManagedAuthStartupAction } from "../src/cli/managed-auth-startup.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	getAuthMigrationState,
	initializeEmptyAuthJson,
	migrateAuthToAuthJson,
	runMigrations,
} from "../src/migrations.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxLoaderPath = resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs");

describe("managed auth initialization", () => {
	const temporaryDirectories: string[] = [];
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	function createAgentDir(): string {
		const directory = mkdtempSync(join(tmpdir(), "pi-managed-auth-initialization-"));
		temporaryDirectories.push(directory);
		process.env[ENV_AGENT_DIR] = directory;
		return directory;
	}

	async function runManagedCli(
		args: string[],
		legacy: boolean,
	): Promise<{ authPath: string; code: number | null; stderr: string; stdout: string }> {
		const root = mkdtempSync(join(tmpdir(), "pi-managed-auth-cli-"));
		temporaryDirectories.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		if (legacy) {
			writeFileSync(
				join(agentDir, "oauth.json"),
				JSON.stringify({ openai: { access: "synthetic-access", refresh: "synthetic-refresh", expires: 1 } }),
				"utf8",
			);
		}

		return await new Promise((resolvePromise, reject) => {
			const child = spawn(process.execPath, ["--import", tsxLoaderPath, cliPath, ...args], {
				cwd: projectDir,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					PI_OFFLINE: "1",
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
					VIVARIUM_MANAGED: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => {
				resolvePromise({ authPath: join(agentDir, "auth.json"), code, stderr, stdout });
			});
		});
	}

	it("distinguishes initialized, legacy, and new auth state", () => {
		const agentDir = createAgentDir();
		expect(getAuthMigrationState()).toBe("none");

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ apiKeys: { openai: "synthetic-key" } }));
		expect(getAuthMigrationState()).toBe("legacy");

		writeFileSync(join(agentDir, "auth.json"), "{}\n");
		expect(getAuthMigrationState()).toBe("initialized");
	});

	it("detects a legacy OAuth file without parsing or changing it", () => {
		const agentDir = createAgentDir();
		const oauthPath = join(agentDir, "oauth.json");
		writeFileSync(oauthPath, "{malformed", "utf8");

		expect(getAuthMigrationState()).toBe("legacy");
		expect(readFileSync(oauthPath, "utf8")).toBe("{malformed");
	});

	it.skipIf(process.platform === "win32")("creates an empty owner-only auth file", () => {
		const agentDir = createAgentDir();
		const authPath = join(agentDir, "auth.json");

		initializeEmptyAuthJson();

		expect(readFileSync(authPath, "utf8")).toBe("{}\n");
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
	});

	it("never overwrites existing auth state", () => {
		const agentDir = createAgentDir();
		const authPath = join(agentDir, "auth.json");
		writeFileSync(authPath, '{"openai":{"type":"api_key","key":"synthetic-existing"}}\n', "utf8");

		initializeEmptyAuthJson();

		expect(readFileSync(authPath, "utf8")).toContain("synthetic-existing");
	});

	it("leaves malformed legacy credentials untouched when import fails", () => {
		const agentDir = createAgentDir();
		const oauthPath = join(agentDir, "oauth.json");
		writeFileSync(oauthPath, "{malformed", "utf8");

		expect(migrateAuthToAuthJson()).toEqual([]);

		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
		expect(readFileSync(oauthPath, "utf8")).toBe("{malformed");
	});

	it("imports legacy credentials only after an explicit migration", () => {
		const agentDir = createAgentDir();
		const oauthPath = join(agentDir, "oauth.json");
		writeFileSync(
			oauthPath,
			JSON.stringify({
				"openai-codex": {
					access: "synthetic-access",
					refresh: "synthetic-refresh",
					expires: 1,
				},
			}),
			"utf8",
		);

		expect(getAuthMigrationState()).toBe("legacy");
		expect(migrateAuthToAuthJson()).toEqual(["openai-codex"]);
		expect(getAuthMigrationState()).toBe("initialized");
		expect(existsSync(oauthPath)).toBe(false);
		expect(existsSync(`${oauthPath}.migrated`)).toBe(true);
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).toMatchObject({
			"openai-codex": { type: "oauth", access: "synthetic-access" },
		});
	});

	it("removes legacy settings keys only after auth.json is created", () => {
		const agentDir = createAgentDir();
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ theme: "dark", apiKeys: { openai: "synthetic-settings-key" } }),
			"utf8",
		);

		expect(migrateAuthToAuthJson()).toEqual(["openai"]);

		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).toMatchObject({
			openai: { type: "api_key", key: "synthetic-settings-key" },
		});
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "dark" });
	});

	it("skips legacy auth during the other startup migrations when requested", () => {
		const agentDir = createAgentDir();
		const oauthPath = join(agentDir, "oauth.json");
		writeFileSync(oauthPath, JSON.stringify({ openai: { access: "synthetic-access" } }), "utf8");

		const result = runMigrations(agentDir, { migrateAuth: false });

		expect(result.migratedAuthProviders).toEqual([]);
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
		expect(readFileSync(oauthPath, "utf8")).toContain("synthetic-access");
	});

	it("requires explicit migration only for managed legacy state", () => {
		expect(requiresManagedAuthMigration(true, "legacy")).toBe(true);
		expect(requiresManagedAuthMigration(false, "legacy")).toBe(false);
		expect(requiresManagedAuthMigration(true, "initialized")).toBe(false);
		expect(requiresManagedAuthMigration(true, "none")).toBe(false);
	});

	it.each([
		[false, "legacy", "interactive", false, "none"],
		[true, "initialized", "interactive", false, "none"],
		[true, "none", "interactive", false, "none"],
		[true, "legacy", "interactive", true, "none"],
		[true, "legacy", "interactive", false, "prompt"],
		[true, "legacy", "print", false, "error"],
		[true, "legacy", "json", false, "error"],
		[true, "legacy", "rpc", false, "error"],
	] as const)(
		"resolves managed=%s state=%s mode=%s metadata=%s to %s",
		(managed, authMigrationState, appMode, metadataCommand, expected) => {
			expect(resolveManagedAuthStartupAction({ managed, authMigrationState, appMode, metadataCommand })).toBe(
				expected,
			);
		},
	);

	it.each([
		["new", false, ["--mode", "json", "--help"], "Usage:"],
		["legacy", true, ["--mode", "json", "--help"], "Usage:"],
		["new", false, ["--list-models"], "models"],
		["legacy", true, ["--list-models"], "models"],
	] as const)("keeps %s managed metadata read-only for %j", async (_state, legacy, args, expectedOutput) => {
		const result = await runManagedCli([...args], legacy);

		expect(result.code).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`.toLowerCase()).toContain(expectedOutput.toLowerCase());
		expect(result.stderr).not.toContain("Legacy credentials were found");
		expect(existsSync(result.authPath)).toBe(false);
	});

	it("parses the explicit auth migration command without provider arguments", () => {
		expect(parseAuthCommand(["auth", "migrate"])).toEqual({
			kind: "migrate",
			args: [],
			json: false,
			credentials: false,
			noRefresh: false,
		});
	});
});
