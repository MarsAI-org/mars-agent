import { Agent } from "@marsai-org/agent-core";
import { AgentSession } from "../../src/session/agent-session";

const outputPath = Bun.env.MARS_TITLE_PROBE_PATH;
if (!outputPath) {
	throw new Error("MARS_TITLE_PROBE_PATH is required");
}

/**
 * Capture the agent-event subscriber the session registers in its constructor
 * so the fake prompt below can drive the deferred-titling path. Deferred
 * titling (fb11c699a9) only fires generateTitle once the assistant reply
 * starts streaming, which the real pipeline signals via a
 * message_update(text_start) event — neither happens under a stubbed prompt.
 */
let agentEventHandler: ((event: unknown) => Promise<void>) | undefined;
const originalSubscribe = Agent.prototype.subscribe;
Agent.prototype.subscribe = function (this: Agent, fn: (event: unknown) => Promise<void>) {
	agentEventHandler = fn;
	return originalSubscribe.call(this, fn as never);
};

let generatedFrom: string | undefined;

AgentSession.prototype.generateTitle = (firstMessage: string): Promise<string | null> => {
	generatedFrom = firstMessage;
	return Promise.resolve("CLI Initial Title");
};

AgentSession.prototype.prompt = async function (): Promise<boolean> {
	// Drive the real event pipeline with synthetic events: a settled operator
	// message records the title input, then the assistant reply starting flips
	// the deferred-title gate and hits the stubbed generateTitle above.
	if (agentEventHandler) {
		await agentEventHandler({
			type: "message_end",
			message: {
				role: "user",
				attribution: "user",
				content: [{ type: "text", text: "implement X" }],
			},
		});
		await agentEventHandler({
			type: "message_update",
			assistantMessageEvent: { type: "text_start" },
		});
	}
	await Bun.sleep(100);
	await Bun.write(outputPath, JSON.stringify({ generatedFrom, sessionName: this.sessionName }));
	process.exit(0);
	return true;
};
