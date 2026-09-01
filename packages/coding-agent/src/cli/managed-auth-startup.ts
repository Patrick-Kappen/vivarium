import type { AppMode } from "../core/project-trust.ts";
import type { AuthMigrationState } from "../migrations.ts";

export type ManagedAuthStartupAction = "none" | "prompt" | "error";

export function requiresManagedAuthMigration(managed: boolean, authMigrationState: AuthMigrationState): boolean {
	return managed && (authMigrationState === "legacy" || authMigrationState === "invalid");
}

export function resolveManagedAuthStartupAction(options: {
	managed: boolean;
	authMigrationState: AuthMigrationState;
	appMode: AppMode;
	metadataCommand: boolean;
}): ManagedAuthStartupAction {
	if (!requiresManagedAuthMigration(options.managed, options.authMigrationState) || options.metadataCommand)
		return "none";
	return options.appMode === "interactive" ? "prompt" : "error";
}
