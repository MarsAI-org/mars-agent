/**
 * Multi-agent orchestrator: coordination over the existing subagent machinery.
 *
 * Public surface for the orchestrator domain. The engine is only constructed
 * when `orchestrator.enabled` is on; with it off, Mars stays on the default
 * single-agent path.
 */

export * from "./types";
export * from "./budget";
export * from "./engine";
export * from "./lease-manager";
export * from "./message-bus";
export * from "./native-runner";
export * from "./permissions";
export * from "./router";
export * from "./settings";
export * from "./task-board";
export * from "./worker-session";
