/**
 * Regression: cancelling the startup `--resume` session picker (e.g. pressing
 * Esc) must terminate the process cleanly. Startup arms long-lived handles
 * (theme/appearance listeners via initTheme, settings save timer, model
 * registry), so the previous bare `return` left the event loop with live
 * handles and the process hung after the picker left the alternate screen.
 *
 * The fix exits via `process.exit(0)` — matching the `--version`/`--export`
 * early-exit convention in the same function. Only this startup call site
 * exits; the in-session `/resume` picker (selector-controller.ts) keeps its own
 * onCancel that just closes the overlay.
 */
import { describe, expect, it, vi } from "bun:test";
import { scaledTimeout } from "./test-timeout";
import * as path from "node:path";
import { parseArgs } from "@marsai-org/coding-agent/cli/args";
import { CliUsageError } from "@marsai-org/coding-agent/cli/usage-error";
import { Settings } from "@marsai-org/coding-agent/config/settings";
import { runRootCommand } from "@marsai-org/coding-agent/main";
import { AuthStorage } from "@marsai-org/coding-agent/session/auth-storage";
import { stopThemeWatcher } from "@marsai-org/tui/theme";
import { setInteractiveHost, TempDir } from "@marsai-org/utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

describe("runRootCommand — startup --resume picker cancellation", () => {
	it(
		"exits cleanly (process.exit 0) when the picker is cancelled instead of returning and hanging",
		async () => {
			using tempDir = TempDir.createSync("@mars-resume-cancel-");
			const sessionDir = tempDir.path();
			// One answered session so folderSessions is non-empty and the picker (not the
			// "No sessions found" probe) is the path under test.
			await Bun.write(
				path.join(sessionDir, "existing.jsonl"),
				[
					JSON.stringify({
						type: "session",
						id: "existing-session",
						cwd: sessionDir,
						timestamp: new Date().toISOString(),
					}),
					JSON.stringify({
						type: "message",
						id: "e1",
						parentId: null,
						timestamp: new Date().toISOString(),
						message: { role: "assistant", content: "prior work" },
					}),
				].join("\n"),
			);

			const authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });

			const parsed = parseArgs(["--resume"]);
			parsed.noExtensions = true;
			parsed.noSkills = true;
			parsed.noRules = true;
			parsed.noTools = true;
			parsed.noLsp = true;
			parsed.sessionDir = sessionDir;

			const previousHost = setInteractiveHost(false);
			const originalIsTTY = process.stdin.isTTY;
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

			const exitCodes: number[] = [];
			vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				exitCodes.push(code ?? 0);
				throw new ProcessExitSignal(code ?? 0);
			}) as typeof process.exit);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			let pickerCalled = false;
			let thrown: unknown;
			try {
				await runRootCommand(parsed, ["--resume"], {
					discoverAuthStorage: async () => authStorage,
					settings,
					selectSession: async () => {
						pickerCalled = true;
						return null; // user cancelled (Esc)
					},
				});
			} catch (err) {
				thrown = err;
			} finally {
				stopThemeWatcher();
				vi.restoreAllMocks();
				Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
				setInteractiveHost(previousHost);
				authStorage.close();
			}

			expect(pickerCalled).toBe(true);
			expect(thrown).toBeInstanceOf(ProcessExitSignal);
			// Exactly one clean exit — proves the cancel branch terminates instead of
			// falling through to session creation or returning into a hang.
			expect(exitCodes).toEqual([0]);
		},
		scaledTimeout(15000),
	);
});

describe("runRootCommand — bare --resume in non-interactive mode", () => {
	it.each([
		{ label: "--print", rawArgs: ["--resume", "--print", "hi"] },
		{ label: "--mode json", rawArgs: ["--resume", "--mode", "json", "hi"] },
		{ label: "--mode rpc", rawArgs: ["--resume", "--mode", "rpc"] },
	])(
		"rejects bare --resume under $label with CliUsageError without opening the picker",
		async ({ rawArgs }) => {
			using tempDir = TempDir.createSync("@mars-resume-noninteractive-");
			const sessionDir = tempDir.path();
			await Bun.write(
				path.join(sessionDir, "existing.jsonl"),
				`${JSON.stringify({ type: "session", id: "existing-session", cwd: sessionDir, timestamp: new Date().toISOString() })}\n`,
			);

			const authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });

			const args = [...rawArgs];
			const parsed = parseArgs(args);
			parsed.noExtensions = true;
			parsed.noSkills = true;
			parsed.noRules = true;
			parsed.noTools = true;
			parsed.noLsp = true;
			parsed.sessionDir = sessionDir;

			const previousHost = setInteractiveHost(false);
			const originalIsTTY = process.stdin.isTTY;
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

			let pickerCalled = false;
			let thrown: unknown;
			try {
				await runRootCommand(parsed, args, {
					discoverAuthStorage: async () => authStorage,
					settings,
					selectSession: async () => {
						pickerCalled = true;
						return null;
					},
				});
			} catch (err) {
				thrown = err;
			} finally {
				stopThemeWatcher();
				vi.restoreAllMocks();
				Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
				setInteractiveHost(previousHost);
				authStorage.close();
			}

			expect(pickerCalled).toBe(false);
			expect(thrown).toBeInstanceOf(CliUsageError);
			expect((thrown as Error).message).toContain(
				"--resume without a session ID or path requires an interactive terminal",
			);
		},
		scaledTimeout(15000),
	);

	it.each([
		{ label: "`-r -p` with closed stdin", extraArgs: ["-r", "-p", "hi"], stdin: "ignore" as const },
		{ label: "`-r` with piped stdin (autoPrint)", extraArgs: ["-r"], stdin: new Blob(["hi\n"]) },
	])(
		"exits with code 2 and a clear stderr error on CLI subprocess $label",
		async ({ extraArgs, stdin }) => {
			using tempDir = TempDir.createSync("@mars-resume-cli-");
			const sessionDir = path.join(tempDir.path(), "sessions");
			const agentDir = path.join(tempDir.path(), "agent");
			await Bun.write(
				path.join(sessionDir, "existing.jsonl"),
				`${JSON.stringify({ type: "session", id: "existing-session", cwd: tempDir.path(), timestamp: new Date().toISOString() })}\n`,
			);

			const proc = Bun.spawn(
				[
					process.execPath,
					cliEntry,
					"--session-dir",
					sessionDir,
					"--no-extensions",
					"--no-skills",
					"--no-rules",
					"--no-tools",
					"--no-lsp",
					...extraArgs,
				],
				{
					cwd: tempDir.path(),
					env: { ...process.env, MARS_CODING_AGENT_DIR: agentDir },
					stdin,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
			expect(exitCode).toBe(2);
			expect(stderr).toContain("--resume without a session ID or path requires an interactive terminal");
		},
		scaledTimeout(15000),
	);
});
