/**
 * Multi-agent orchestrator: coordination over the existing subagent machinery.
 *
 * Public surface for the orchestrator domain. The engine is only constructed
 * when `orchestrator.enabled` is on; with it off, Mars stays on the default
 * single-agent path.
 */

export * from "./types";
export * from "./board-model";
export * from "./budget";
export * from "./engine";
export * from "./git-integrator";
export * from "./lease-manager";
export * from "./message-bus";
export * from "./mode";
export * from "./native-runner";
export * from "./permissions";
export * from "./router";
export * from "./run-store";
export * from "./settings";
export * from "./spec-loader";
export * from "./task-board";
export * from "./verifier";
export * from "./worker-session";
