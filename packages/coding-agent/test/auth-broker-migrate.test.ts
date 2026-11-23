import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@marsai-org/ai";
import { AuthBrokerClient, type AuthBrokerServerHandle, startAuthBroker } from "@marsai-org/ai/auth-broker";
import { runAuthBrokerCommand } from "@marsai-org/coding-agent/cli/auth-broker-cli";
import { getAgentDbPath, removeWithRetries, setAgentDir } from "@marsai-org/utils";

const TEAM_ORG = "org-team-1111";

async function runMigrateCapturingStdout(): Promise<string> {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await runAuthBrokerCommand({
			action: "migrate",
			flags: { fromLocal: true, includeOauth: true },
		});
	} finally {
		process.stdout.write = originalWrite;
	}
	return captured;
}

describe("auth-broker migrate (org-only dedupe)", () => {
	let agentDir = "";
	let brokerAgentDir = "";
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "broker-migrate-bearer";
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		savedEnv.MARS_AUTH_BROKER_URL = process.env.MARS_AUTH_BROKER_URL;
		savedEnv.MARS_AUTH_BROKER_TOKEN = process.env.MARS_AUTH_BROKER_TOKEN;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-migrate-client-"));
		brokerAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mars-migrate-broker-"));
		setAgentDir(agentDir);

		brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerAgentDir, "agent.db"));
		brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.credentials.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		process.env.MARS_AUTH_BROKER_URL = handle.url;
		process.env.MARS_AUTH_BROKER_TOKEN = token;
	});

	afterEach(async () => {
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		await removeWithRetries(agentDir);
		await removeWithRetries(brokerAgentDir);
		for (const key of ["MARS_AUTH_BROKER_URL", "MARS_AUTH_BROKER_TOKEN"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("rerun skips an already-migrated org-only row instead of re-uploading a stale refresh token", async () => {
		// Local row where login recovered neither email nor account: the org id
		// is the only identity the broker snapshot can echo back.
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential("anthropic", {
				type: "oauth",
				access: "access-local",
				refresh: "refresh-local-stale",
				expires: Date.now() + 3_600_000,
				orgId: TEAM_ORG,
				orgName: "Team",
			});
		} finally {
			localStore.close();
		}

		const firstRun = await runMigrateCapturingStdout();
		expect(firstRun).toContain("uploaded");
		const uploaded = brokerStore!.getOAuth("anthropic");
		expect(uploaded?.refresh).toBe("refresh-local-stale");
		expect(uploaded?.orgId).toBe(TEAM_ORG);

		// The broker rotates the token after migration — its copy is now newer
		// than the local one.
		await brokerStore!.upsertAuthCredential("anthropic", {
			type: "oauth",
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 7_200_000,
			orgId: TEAM_ORG,
			orgName: "Team",
		});
		await brokerStorage!.credentials.reload();

		// Rerun: the org-only row must be recognized as already migrated, not
		// re-uploaded (which would clobber the broker's newer refresh token).
		const secondRun = await runMigrateCapturingStdout();
		expect(secondRun).toContain("already on broker");
		expect(secondRun).toContain("Nothing to migrate");
		const persisted = brokerStore!.getOAuth("anthropic");
		expect(persisted?.refresh).toBe("refresh-rotated");
		expect(brokerStore!.listAuthCredentials("anthropic")).toHaveLength(1);
	});

	test("migrate --json emits a single valid JSON object and reports upload failures accurately", async () => {
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential("anthropic", { type: "api_key", key: "sk-ant-ok" });
			await localStore.upsertAuthCredential("openai", { type: "api_key", key: "sk-openai-fail" });
		} finally {
			localStore.close();
		}

		const originalUpload = AuthBrokerClient.prototype.uploadCredential;
		const uploadSpy = vi
			.spyOn(AuthBrokerClient.prototype, "uploadCredential")
			.mockImplementation(async function (this: AuthBrokerClient, provider, credential) {
				if (provider === "openai") {
					throw new Error("broker rejected openai key");
				}
				return originalUpload.call(this, provider, credential);
			});

		const originalWrite = process.stdout.write.bind(process.stdout);
		const prevExitCode = process.exitCode;
		let captured = "";
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await runAuthBrokerCommand({
				action: "migrate",
				flags: { fromLocal: true, json: true },
			});
			const parsed = JSON.parse(captured) as {
				dryRun: boolean;
				imported: Array<{ source: string; provider: string; identity: string }>;
				failed: Array<{ source: string; provider: string; identity: string; error: string }>;
				plan: Array<{ provider: string }>;
			};
			expect(parsed.dryRun).toBe(false);
			expect(parsed.plan).toHaveLength(2);
			expect(parsed.imported).toEqual([{ source: "local-sqlite", provider: "anthropic", identity: "(api key)" }]);
			expect(parsed.failed).toEqual([
				{
					source: "local-sqlite",
					provider: "openai",
					identity: "(api key)",
					error: "broker rejected openai key",
				},
			]);
			expect(process.exitCode).toBe(1);
		} finally {
			process.stdout.write = originalWrite;
			process.exitCode = prevExitCode ?? 0;
			uploadSpy.mockRestore();
		}
	});
});
