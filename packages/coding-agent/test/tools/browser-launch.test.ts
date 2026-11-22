import { describe, expect, it } from "bun:test";

import * as fs from "node:fs";
import * as path from "node:path";
import {
	chromiumExecutableProbeForTest,
	resolveSharedBrowserLaunchSpec,
	stealthIgnoreDefaultArgsForTest,
	systemChromiumCandidatesForTest,
} from "@marsai-org/coding-agent/tools/browser/launch";
import { TempDir } from "@marsai-org/utils";
import { BrowserPlatform, computeExecutablePath } from "@marsai-org/utils/browsers";
import { APP_NAME } from "@marsai-org/utils/dirs";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

const EXECUTABLE_PROBE = path.resolve(import.meta.dir, "../fixtures/browser-executable-probe.ts");

const AUTOMATION_FLAG = "--enable-automation";

const EDGE_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/microsoft-edge-stable",
] as const;

const CHROME_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium",
] as const;

describe("browser launch stealth defaults", () => {
	it("keeps Puppeteer's automation default for Microsoft Edge executables", () => {
		for (const executablePath of EDGE_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).not.toContain(AUTOMATION_FLAG);
			expect(ignoreDefaultArgs).toContain("--disable-extensions");
		}
	});

	it("continues filtering Puppeteer's automation default for Chrome and Chromium executables", () => {
		for (const executablePath of CHROME_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).toContain(AUTOMATION_FLAG);
		}
	});
});

describe("shared browser launch", () => {
	it("suppresses the broker-owned blank startup window", async () => {
		const previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
		process.env.PUPPETEER_EXECUTABLE_PATH = "/test/chrome";
		try {
			const launch = await resolveSharedBrowserLaunchSpec({
				headless: true,
				userDataDir: "/test/profile",
			});

			expect(launch?.args).toContain("--no-startup-window");
		} finally {
			if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
			else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
		}
	});
});

const UNGOOGLED_CHROMIUM_FLATPAK_ID = "io.github.ungoogled_software.ungoogled_chromium";

describe("system Chromium candidates", () => {
	const linuxCandidates = (which: (name: string) => string | undefined = () => undefined) =>
		systemChromiumCandidatesForTest("linux", "/home/test", which);

	it("offers Ungoogled Chromium executables on Linux", () => {
		const candidates = linuxCandidates();

		expect(candidates).toContain("/usr/bin/ungoogled-chromium");
		expect(candidates).toContain("/usr/bin/ungoogled-chromium-browser");
		expect(candidates).toContain(`/var/lib/flatpak/exports/bin/${UNGOOGLED_CHROMIUM_FLATPAK_ID}`);
		expect(candidates).toContain(
			path.join("/home/test", ".local/share/flatpak/exports/bin", UNGOOGLED_CHROMIUM_FLATPAK_ID),
		);
	});

	it("keeps the previously supported Linux executables", () => {
		const candidates = linuxCandidates();

		for (const executablePath of [
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
			"/var/lib/flatpak/exports/bin/com.google.Chrome",
			"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
		]) {
			expect(candidates).toContain(executablePath);
		}
	});

	it("ranks PATH-resolved Ungoogled Chromium below stock builds", () => {
		const ungoogledPath = "/custom/bin/ungoogled-chromium";
		const candidates = linuxCandidates(name => (name === "ungoogled-chromium" ? ungoogledPath : undefined));
		const ungoogled = candidates.indexOf(ungoogledPath);

		for (const executablePath of [
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/snap/bin/chromium",
			"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
		]) {
			expect(ungoogled).toBeGreaterThan(candidates.indexOf(executablePath));
		}
	});

	it("does not add Ungoogled Chromium candidates on macOS or Windows", () => {
		for (const platform of ["darwin", "win32"] as const) {
			const candidates = systemChromiumCandidatesForTest(platform, "/home/test", () => "/custom/ungoogled");
			expect(candidates.some(candidate => candidate.toLowerCase().includes("ungoogled"))).toBeFalse();
		}
	});
});

describe("browser executable selection", () => {
	it.skipIf(process.platform !== "linux")(
		"rejects executable wrappers that are not Chromium-family browsers",
		async () => {
			const tempDir = TempDir.createSync("@browser-probe-");
			try {
				const wrapper = path.join(tempDir.path(), "google-chrome");
				const chromium = path.join(tempDir.path(), "chromium");
				const nonExecutable = path.join(tempDir.path(), "not-executable");
				await Bun.write(wrapper, "#!/bin/sh\necho browser bridge\n");
				await Bun.write(chromium, "#!/bin/sh\necho Chromium 123.0\n");
				await Bun.write(nonExecutable, "#!/bin/sh\necho Chromium 123.0\n");
				fs.chmodSync(wrapper, 0o755);
				fs.chmodSync(chromium, 0o755);
				fs.chmodSync(nonExecutable, 0o644);

				await expect(chromiumExecutableProbeForTest(wrapper)).resolves.toBe(false);
				await expect(chromiumExecutableProbeForTest(chromium)).resolves.toBe(true);
				await expect(chromiumExecutableProbeForTest(nonExecutable)).resolves.toBe(false);
			} finally {
				await tempDir.remove();
			}
		},
	);

	it.skipIf(process.platform !== "linux")("rejects wrappers that hang during the version probe", async () => {
		const tempDir = TempDir.createSync("@browser-probe-hanging-");
		try {
			const hangingWrapper = path.join(tempDir.path(), "google-chrome");
			await Bun.write(hangingWrapper, "#!/bin/sh\nsleep 60\n");
			fs.chmodSync(hangingWrapper, 0o755);

			const startedAt = performance.now();
			await expect(chromiumExecutableProbeForTest(hangingWrapper)).resolves.toBe(false);
			expect(performance.now() - startedAt).toBeLessThan(5000);
		} finally {
			await tempDir.remove();
		}
	});

	it("does not launch the candidate to probe its version off Linux (#8445)", async () => {
		for (const platform of ["win32", "darwin"] as const) {
			const tempDir = TempDir.createSync(`@browser-probe-${platform}-`);
			try {
				const marker = path.join(tempDir.path(), "gui-launched");
				const fakeChrome = path.join(tempDir.path(), "chrome.exe");
				// A GUI browser handoff: executing it has a side effect (this marker)
				// but prints nothing a console version probe would accept.
				await Bun.write(fakeChrome, `#!/bin/sh\ntouch "${marker}"\necho "activating existing window"\n`);
				fs.chmodSync(fakeChrome, 0o755);

				const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
				Object.defineProperty(process, "platform", { value: platform, configurable: true });
				try {
					await expect(chromiumExecutableProbeForTest(fakeChrome)).resolves.toBe(true);
				} finally {
					if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
				}

				expect(fs.existsSync(marker)).toBe(false);
			} finally {
				await tempDir.remove();
			}
		}
	});

	it("honors PUPPETEER_EXECUTABLE_PATH before a detected Windows system Chrome", async () => {
		const tempDir = TempDir.createSync("@browser-executable-");
		try {
			const override = path.join(tempDir.path(), "chrome-headless-shell.exe");
			const systemChrome = path.join(tempDir.path(), "Google\\Chrome\\Application\\chrome.exe");
			await Bun.write(override, "override");
			await Bun.write(systemChrome, "system");

			const result = Bun.spawnSync([process.execPath, EXECUTABLE_PROBE], {
				env: {
					...process.env,
					MARS_BROWSER_PROBE_PLATFORM: "win32",
					ProgramFiles: tempDir.path(),
					"ProgramFiles(x86)": path.join(tempDir.path(), "missing-x86"),
					LOCALAPPDATA: path.join(tempDir.path(), "missing-local"),
					PUPPETEER_EXECUTABLE_PATH: override,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = new TextDecoder().decode(result.stderr);

			expect(result.exitCode, stderr).toBe(0);
			expect(new TextDecoder().decode(result.stdout)).toBe(override);
		} finally {
			await tempDir.remove();
		}
	});

	// darwin-only, and it has to be: the probe reads the real host through
	// `os.platform()` (packages/utils/src/browsers.ts), so the fixture's
	// `process.platform` pin cannot make a Linux or Windows host take the macOS
	// branch — off darwin the child falls through to a network download and burns
	// the test budget. The child pins its puppeteer cache via XDG_CACHE_HOME,
	// which the dirs resolver honors only on Linux/macOS hosts.
	it.skipIf(process.platform !== "darwin")(
		"prefers Chrome for Testing over a detected system Chrome on macOS (#8673)",
		async () => {
			const tempDir = TempDir.createSync("@browser-macos-cft-");
			try {
				const home = path.join(tempDir.path(), "home");
				const xdgCache = path.join(tempDir.path(), "cache");
				// resolveIf() (packages/utils/src/dirs.ts) only redirects to an XDG
				// root when its `<XDG>/mars` dir already exists, so create them to pin
				// the child's puppeteer cache to this isolated location.
				for (const xdg of [xdgCache, path.join(tempDir.path(), "data"), path.join(tempDir.path(), "state")]) {
					fs.mkdirSync(path.join(xdg, APP_NAME), { recursive: true });
				}
				// The probe child inherits this process's environment, and ANY agent-dir
				// override in that namespace (MARS_CODING_AGENT_DIR, the legacy
				// PI_CODING_AGENT_DIR, or a profile/config dir) makes the dirs resolver treat
				// the install as non-default and skip the XDG roots below. The seed would
				// then sit in a cache the child never reads, and the probe would fall
				// through to a network download that outlives the test budget. Strip the
				// whole namespace and re-add only the switches this test means to set.
				const inherited = Object.entries(process.env).filter(
					([key, value]) => value !== undefined && !key.startsWith("MARS_") && !key.startsWith("PI_"),
				) as [string, string][];
				const env: Record<string, string> = Object.fromEntries(inherited);
				Object.assign(env, {
					HOME: home,
					XDG_CACHE_HOME: xdgCache,
					XDG_DATA_HOME: path.join(tempDir.path(), "data"),
					XDG_STATE_HOME: path.join(tempDir.path(), "state"),
					MARS_BROWSER_PROBE_PLATFORM: "darwin",
					PUPPETEER_EXECUTABLE_PATH: "",
				});

				// System Google Chrome bundle (com.google.Chrome) — the LaunchServices
				// hijacker the fix must avoid selecting.
				const systemChrome = path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
				await Bun.write(systemChrome, "#!/bin/sh\necho 'Google Chrome 151'\n");
				fs.chmodSync(systemChrome, 0o755);

				// Seed the isolated Chrome for Testing binary in the child's cache so the
				// probe resolves it without a network download. getPuppeteerDir() resolves
				// to `<XDG_CACHE_HOME>/mars/puppeteer` given the dirs created above.
				const cacheDir = path.join(xdgCache, APP_NAME, "puppeteer");
				// Seeded (and compared) in the same shape the module resolves on this
				// host, so a macOS x64 and a macOS arm64 runner each look where the seed
				// actually landed instead of at a hard-coded arch directory.
				const platform = process.arch === "arm64" ? BrowserPlatform.MAC_ARM : BrowserPlatform.MAC;
				const buildId = PUPPETEER_REVISIONS.chrome;
				const chromeForTesting = computeExecutablePath({ buildId, cacheDir, platform });
				await Bun.write(chromeForTesting, "#!/bin/sh\necho 'Chrome for Testing'\n");
				fs.chmodSync(chromeForTesting, 0o755);

				const result = Bun.spawnSync([process.execPath, EXECUTABLE_PROBE], { env, stdout: "pipe", stderr: "pipe" });
				const stderr = new TextDecoder().decode(result.stderr);

				expect(result.exitCode, stderr).toBe(0);
				const selected = new TextDecoder().decode(result.stdout);
				expect(selected).toBe(chromeForTesting);
				expect(selected).not.toBe(systemChrome);
			} finally {
				await tempDir.remove();
			}
		},
	);
});
