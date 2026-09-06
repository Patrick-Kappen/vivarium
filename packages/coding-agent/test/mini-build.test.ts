import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// PR #16: the published build excludes mini, but its development --dist workflow must work.
test("builds mini entrypoints without publishing them", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-mini-build-"));
	try {
		const fixturePackage = join(root, "packages", "coding-agent");
		const output = join(fixturePackage, "dist");
		mkdirSync(fixturePackage, { recursive: true });
		copyFileSync(join(packageDir, "package.json"), join(fixturePackage, "package.json"));
		copyFileSync(join(repoRoot, "mini-test.sh"), join(root, "mini-test.sh"));
		symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "junction");

		execFileSync(
			process.execPath,
			[
				join(repoRoot, "node_modules", "@typescript", "native-preview", "bin", "tsgo.js"),
				"-p",
				join(packageDir, "tsconfig.mini.json"),
				"--outDir",
				output,
			],
			{ timeout: 30_000 },
		);
		for (const entry of ["main.js", "server/entry.js", "worker/entry.js"]) {
			expect(existsSync(join(output, "experimental", "mini", entry))).toBe(true);
		}

		const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		expect(packageJson.scripts["build:mini"]).toContain("tsgo -p tsconfig.mini.json");
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
				shell: process.platform === "win32",
				cwd: fixturePackage,
				encoding: "utf8",
				timeout: 30_000,
			}),
		) as Array<{ files: Array<{ path: string }> }>;
		expect(packed[0].files.some(({ path }) => path.startsWith("dist/experimental/"))).toBe(false);
		expect(packed[0].files.some(({ path }) => path.startsWith("dist/core/"))).toBe(true);

		if (process.platform !== "win32") {
			// Invalid args exercise the real imports and launcher without starting a server or provider.
			const result = spawnSync("bash", [join(root, "mini-test.sh"), "--dist", "--invalid-smoke-argument"], {
				encoding: "utf8",
				timeout: 15_000,
				env: { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1" },
			});
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("Unknown argument: --invalid-smoke-argument");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
