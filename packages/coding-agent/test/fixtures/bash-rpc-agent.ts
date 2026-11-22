import * as path from "node:path";
import { Agent } from "@marsai-org/agent-core";
import { getBundledModel } from "@marsai-org/catalog/models";
import { ModelRegistry } from "@marsai-org/coding-agent/config/model-registry";
import { Settings } from "@marsai-org/coding-agent/config/settings";
import { runRpcMode } from "@marsai-org/coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@marsai-org/coding-agent/session/agent-session";
import { AuthStorage } from "@marsai-org/coding-agent/session/auth-storage";
import { convertToLlm } from "@marsai-org/coding-agent/session/messages";
import { SessionManager } from "@marsai-org/coding-agent/session/session-manager";

// Real RPC dispatch, native bash execution and transcript storage; model requests are forbidden.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const agent = new Agent({
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: [], tools: [] },
	convertToLlm,
	streamFn: () => {
		throw new Error("bash-rpc-agent must not call a model");
	},
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(cwd),
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});
await runRpcMode(session);
