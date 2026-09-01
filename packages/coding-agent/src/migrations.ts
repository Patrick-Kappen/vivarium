/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir } from "./config.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import { stripBom } from "./utils/text.ts";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

export type AuthMigrationState = "initialized" | "legacy" | "invalid" | "none";
export type AuthMigrationResult =
	| { status: "migrated"; providers: string[] }
	| { status: "already_initialized" }
	| { status: "no_credentials" }
	| { status: "invalid_legacy" };

export function getAuthMigrationState(): AuthMigrationState {
	const agentDir = getAgentDir();
	if (existsSync(join(agentDir, "auth.json"))) return "initialized";

	const oauthPath = join(agentDir, "oauth.json");
	if (existsSync(oauthPath)) {
		try {
			const oauth: unknown = JSON.parse(stripBom(readFileSync(oauthPath, "utf-8")));
			if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) return "invalid";
			if (Object.keys(oauth).length > 0) return "legacy";
		} catch {
			return "invalid";
		}
	}

	try {
		const settings = JSON.parse(stripBom(readFileSync(join(agentDir, "settings.json"), "utf-8"))) as unknown;
		if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return "none";
		const apiKeys = (settings as Record<string, unknown>).apiKeys;
		if (typeof apiKeys !== "object" || apiKeys === null || Array.isArray(apiKeys)) return "none";
		return Object.values(apiKeys).some((value) => typeof value === "string" && value.length > 0) ? "legacy" : "none";
	} catch {
		return "none";
	}
}

export function initializeEmptyAuthJson(): void {
	const authPath = join(getAgentDir(), "auth.json");
	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(authPath, "{}\n", { encoding: "utf-8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns A result that distinguishes migration, concurrent initialization,
 * missing credentials, and invalid legacy sources.
 */
export function migrateAuthToAuthJson(): AuthMigrationResult {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Another startup may have initialized auth state before this one runs.
	if (existsSync(authPath)) return { status: "already_initialized" };

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];
	let migrateOauthFile = false;
	let migratedSettings: string | undefined;
	let invalidLegacySource = false;

	// Read oauth.json without changing it. Legacy files are cleaned up only after
	// auth.json has been created successfully, so a failed import does not lose credentials.
	if (existsSync(oauthPath)) {
		try {
			const oauth: unknown = JSON.parse(stripBom(readFileSync(oauthPath, "utf-8")));
			if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) {
				invalidLegacySource = true;
			} else {
				for (const [provider, cred] of Object.entries(oauth)) {
					migrated[provider] = { type: "oauth", ...(cred as object) };
					providers.push(provider);
				}
				migrateOauthFile = providers.length > 0;
			}
		} catch {
			invalidLegacySource = true;
		}
	}

	// Read settings.json apiKeys without changing the source file.
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(stripBom(content));
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string" && key.length > 0) {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				migratedSettings = JSON.stringify(settings, null, 2);
			}
		} catch {
			invalidLegacySource = true;
		}
	}

	if (invalidLegacySource) return { status: "invalid_legacy" };
	if (Object.keys(migrated).length === 0) return { status: "no_credentials" };

	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "already_initialized" };
		throw error;
	}

	if (migrateOauthFile) {
		try {
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// auth.json is authoritative; leave the legacy source in place if cleanup fails.
		}
	}
	if (migratedSettings !== undefined) {
		try {
			writeFileSync(settingsPath, migratedSettings, "utf-8");
		} catch {
			// auth.json is authoritative; leave the legacy source in place if cleanup fails.
		}
	}

	return { status: "migrated", providers };
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(stripBom(readFileSync(configPath, "utf-8"))) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(
	cwd: string,
	options: { migrateAuth?: boolean } = {},
): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const authMigration = options.migrateAuth === false ? undefined : migrateAuthToAuthJson();
	const migratedAuthProviders = authMigration?.status === "migrated" ? authMigration.providers : [];
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
