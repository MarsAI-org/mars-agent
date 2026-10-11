import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const launcherPath = path.resolve(import.meta.dir, "../../../scripts/android/mars-termux-launcher.sh");

describe("mars-termux-launcher.sh", () => {
	test("fails with remediation instructions when glibc runner is missing", async () => {
		const result = await $`sh ${launcherPath}`
			.env({ PATH: "/usr/bin:/bin", PREFIX: "", GLIBC_RUNNER: "" })
			.quiet()
			.nothrow();

		expect(result.exitCode).toBe(127);
		expect(result.stderr.toString()).toContain("pkg install glibc-runner");
	});

	test("fails with message when target binary is missing", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-test-"));
		const fakeGrun = path.join(tmp, "grun");
		await Bun.write(fakeGrun, '#!/bin/sh\nexec "$@"');
		await fs.chmod(fakeGrun, 0o755);

		try {
			const result = await $`sh ${launcherPath}`
				.env({
					PATH: `${tmp}:/usr/bin:/bin`,
					MARS_BIN: path.join(tmp, "non-existent-binary"),
				})
				.quiet()
				.nothrow();

			expect(result.exitCode).toBe(1);
			expect(result.stderr.toString()).toContain("Mars binary for linux-arm64 not found");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test("forwards arguments and clears LD_PRELOAD when runner exists", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-test-"));
		const fakeGrun = path.join(tmp, "grun");
		const fakeBinary = path.join(tmp, "mars-binary");
		const logFile = path.join(tmp, "output.log");

		// Fake runner executes the binary
		await Bun.write(fakeGrun, '#!/bin/sh\nexec "$@"');
		await fs.chmod(fakeGrun, 0o755);

		// Fake binary logs arguments and LD_PRELOAD state
		await Bun.write(
			fakeBinary,
			`#!/bin/sh\necho "ARGS: $*" > "${logFile}"\necho "LD_PRELOAD: \${LD_PRELOAD:-UNSET}" >> "${logFile}"\nexit 0`,
		);
		await fs.chmod(fakeBinary, 0o755);

		try {
			const result = await $`sh ${launcherPath} --version --json`
				.env({
					PATH: `${tmp}:/usr/bin:/bin`,
					MARS_BIN: fakeBinary,
					LD_PRELOAD: "/system/lib/libtermux-exec.so",
				})
				.quiet()
				.nothrow();

			expect(result.exitCode).toBe(0);
			const log = await Bun.file(logFile).text();
			expect(log).toContain("ARGS: --version --json");
			expect(log).toContain("LD_PRELOAD: UNSET");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
