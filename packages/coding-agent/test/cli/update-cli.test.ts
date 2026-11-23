import { afterEach, describe, expect, it, vi } from "bun:test";
import { getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks GitHub release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json([{ tag_name: "v999.0.0", draft: false, prerelease: false, assets: [] }]);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("getLatestRelease GitHub releases", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("selects the newest stable published release and skips drafts and prereleases", async () => {
		const urls: string[] = [];
		const fetchStub = async (input: FetchInput) => {
			urls.push(String(input));
			return Response.json([
				{ tag_name: "v0.9.0", draft: true, prerelease: false, assets: [] },
				{ tag_name: "v0.8.0-canary.1", draft: false, prerelease: true, assets: [] },
				{ tag_name: "v0.4.0", draft: false, prerelease: false, assets: [] },
				{ tag_name: "v0.3.1", draft: false, prerelease: false, assets: [] },
			]);
		};

		const release = await getLatestRelease({ fetchImpl: fetchStub, githubToken: "test-token" });

		expect(release).toEqual({ tag: "v0.4.0", version: "0.4.0" });
		expect(urls).toEqual(["https://api.github.com/repos/MarsAI-org/mars-agent/releases?per_page=30"]);
	});

	it("selects prereleases when checking the canary channel", async () => {
		const fetchStub = async () =>
			Response.json([
				{ tag_name: "v0.5.0-canary.2", draft: false, prerelease: true, assets: [] },
				{ tag_name: "v0.4.0", draft: false, prerelease: false, assets: [] },
			]);

		const release = await getLatestRelease({ channel: "canary", fetchImpl: fetchStub, githubToken: "test-token" });

		expect(release).toEqual({ tag: "v0.5.0-canary.2", version: "0.5.0-canary.2" });
	});

	it("reports when no canary release has been published yet", async () => {
		const fetchStub = async () =>
			Response.json([{ tag_name: "v0.4.0", draft: false, prerelease: false, assets: [] }]);

		await expect(
			getLatestRelease({ channel: "canary", fetchImpl: fetchStub, githubToken: "test-token" }),
		).rejects.toThrow("No canary release has been published");
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = async () => {
			throw new Error(
				'UnsupportedProxyProtocol fetching "https://api.github.com/repos/MarsAI-org/mars-agent/releases?per_page=30". ' +
					"For more information, pass `verbose: true` in the second argument to fetch()",
			);
		};

		const err = await getLatestRelease({ timeoutMs: 5000, fetchImpl: fetchStub, githubToken: "test-token" }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
