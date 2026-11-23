/**
 * Declarative Swarm Workflow Spec Loader.
 *
 * Parses and validates YAML (`.yaml`/`.yml`) and JSON (`.json`/`.json5`) swarm
 * workflow definitions into a canonical `SwarmSpec`, and compiles specs into
 * `OrchestratorPlan` instances for the orchestration engine.
 *
 * Supports both canonical camelCase keys and legacy `swarm-extension` snake_case
 * aliases (`waits_for`, `target_files`, `worker`, `role`, `role_label`, `tools`,
 * `target_count`).
 */

import * as path from "node:path";
import { isRecord } from "@marsai-org/utils";
import type { OrchestratorPlan, OrchestratorTask, WorkerBackendKind, WorkerSpec } from "./types";

export type SwarmSpecMode = "dag" | "pipeline";
export type SwarmSpecFormat = "yaml" | "json";

export interface SwarmSpecWorker {
	readonly id: string;
	readonly roleLabel: string;
	readonly backend: WorkerBackendKind;
	readonly requestedTools?: readonly string[];
	readonly model?: string;
	readonly isolated: boolean;
	readonly agent?: string;
}

export interface SwarmSpecTask {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly dependencies: readonly string[];
	readonly targetFiles: readonly string[];
	readonly agent?: string;
}

export interface SwarmSpec {
	readonly name?: string;
	readonly goal: string;
	readonly mode: SwarmSpecMode;
	/** >= 1, default 1 (for mode: "pipeline", runs N sequential passes). */
	readonly iterations: number;
	readonly maxConcurrency?: number;
	readonly maxRetries?: number;
	readonly isolated?: boolean;
	readonly verificationChecks?: readonly string[];
	readonly workers: readonly SwarmSpecWorker[];
	readonly tasks: readonly SwarmSpecTask[];
}

function parseRawContent(content: string, format: SwarmSpecFormat): unknown {
	if (content.trim() === "") {
		throw new Error("Swarm spec content cannot be empty");
	}
	try {
		if (format === "json") {
			return Bun.JSON5.parse(content);
		}
		return Bun.YAML.parse(content);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${format.toUpperCase()} swarm spec: ${detail}`);
	}
}

function readOptionalString(record: Record<string, unknown>, key: string, context: string): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new Error(`Invalid ${context}: "${key}" must be a string`);
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(record: Record<string, unknown>, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Invalid ${context}: "${key}" must be a non-empty string`);
	}
	return value.trim();
}

function readStringArray(
	record: Record<string, unknown>,
	keys: readonly string[],
	context: string,
): readonly string[] | undefined {
	let foundKey: string | undefined;
	let rawValue: unknown;
	for (const key of keys) {
		if (record[key] !== undefined) {
			foundKey = key;
			rawValue = record[key];
			break;
		}
	}
	if (foundKey === undefined || rawValue === undefined) return undefined;
	if (!Array.isArray(rawValue)) {
		throw new Error(`Invalid ${context}: "${foundKey}" must be an array of strings`);
	}
	const result: string[] = [];
	for (const item of rawValue) {
		if (typeof item !== "string" || item.trim().length === 0) {
			throw new Error(`Invalid ${context}: "${foundKey}" must contain only non-empty strings`);
		}
		result.push(item.trim());
	}
	return result;
}

function parsePositiveInteger(value: unknown, fieldName: string, min = 1): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new Error(`Invalid swarm spec: "${fieldName}" must be an integer >= ${min}`);
	}
	return value;
}

function parseWorkers(
	rawWorkers: unknown,
	defaultIsolated: boolean,
	tasks: readonly SwarmSpecTask[],
): readonly SwarmSpecWorker[] {
	if (rawWorkers === undefined) {
		// Synthesize workers from distinct task agent/worker assignments or fall back to worker-1.
		const agentIds: string[] = [];
		const seen = new Set<string>();
		for (const task of tasks) {
			if (task.agent && !seen.has(task.agent)) {
				seen.add(task.agent);
				agentIds.push(task.agent);
			}
		}
		if (agentIds.length === 0) {
			return [
				{
					id: "worker-1",
					roleLabel: "worker-1",
					backend: "native",
					isolated: defaultIsolated,
				},
			];
		}
		return agentIds.map(id => ({
			id,
			roleLabel: id,
			backend: "native",
			isolated: defaultIsolated,
		}));
	}

	if (!Array.isArray(rawWorkers) || rawWorkers.length === 0) {
		throw new Error('Invalid swarm spec: "workers" must be a non-empty array when provided');
	}

	const seenIds = new Set<string>();
	const workers: SwarmSpecWorker[] = [];

	for (let i = 0; i < rawWorkers.length; i++) {
		const rawWorker = rawWorkers[i];
		if (!isRecord(rawWorker)) {
			throw new Error(`Invalid swarm spec: worker at index ${i} must be an object`);
		}
		const id = readRequiredString(rawWorker, "id", `worker[${i}]`);
		if (seenIds.has(id)) {
			throw new Error(`Invalid swarm spec: duplicate worker id "${id}"`);
		}
		seenIds.add(id);

		const roleLabel =
			readOptionalString(rawWorker, "roleLabel", `worker "${id}"`) ??
			readOptionalString(rawWorker, "role_label", `worker "${id}"`) ??
			readOptionalString(rawWorker, "role", `worker "${id}"`) ??
			id;

		let backend: WorkerBackendKind = "native";
		if (rawWorker.backend !== undefined) {
			if (rawWorker.backend !== "native" && rawWorker.backend !== "external-cli") {
				throw new Error(`Invalid worker "${id}": backend must be "native" or "external-cli"`);
			}
			backend = rawWorker.backend;
		}

		const requestedTools = readStringArray(
			rawWorker,
			["requestedTools", "requested_tools", "tools"],
			`worker "${id}"`,
		);
		const model = readOptionalString(rawWorker, "model", `worker "${id}"`);
		const agent = readOptionalString(rawWorker, "agent", `worker "${id}"`);

		let isolated = defaultIsolated;
		if (rawWorker.isolated !== undefined) {
			if (typeof rawWorker.isolated !== "boolean") {
				throw new Error(`Invalid worker "${id}": "isolated" must be a boolean`);
			}
			isolated = rawWorker.isolated;
		}

		workers.push({
			id,
			roleLabel,
			backend,
			...(requestedTools === undefined ? {} : { requestedTools }),
			...(model === undefined ? {} : { model }),
			...(agent === undefined ? {} : { agent }),
			isolated,
		});
	}

	return workers;
}

function parseTasks(rawTasks: unknown): readonly SwarmSpecTask[] {
	if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
		throw new Error('Invalid swarm spec: "tasks" must be a non-empty array');
	}

	const seenIds = new Set<string>();
	const tasks: SwarmSpecTask[] = [];

	for (let i = 0; i < rawTasks.length; i++) {
		const rawTask = rawTasks[i];
		if (!isRecord(rawTask)) {
			throw new Error(`Invalid swarm spec: task at index ${i} must be an object`);
		}
		const id = readRequiredString(rawTask, "id", `task[${i}]`);
		if (seenIds.has(id)) {
			throw new Error(`Invalid swarm spec: duplicate task id "${id}"`);
		}
		seenIds.add(id);

		const rawTitle = readOptionalString(rawTask, "title", `task "${id}"`);
		const rawDescription =
			readOptionalString(rawTask, "description", `task "${id}"`) ??
			readOptionalString(rawTask, "prompt", `task "${id}"`);

		if (!rawTitle && !rawDescription) {
			throw new Error(`Invalid task "${id}": must provide "title" or "description"`);
		}

		const title = rawTitle ?? id;
		const description = rawDescription ?? rawTitle ?? id;
		const dependencies = readStringArray(rawTask, ["dependencies", "waits_for"], `task "${id}"`) ?? [];
		const targetFiles = readStringArray(rawTask, ["targetFiles", "target_files"], `task "${id}"`) ?? [];
		const agent =
			readOptionalString(rawTask, "worker", `task "${id}"`) ?? readOptionalString(rawTask, "agent", `task "${id}"`);

		tasks.push({
			id,
			title,
			description,
			dependencies,
			targetFiles,
			...(agent === undefined ? {} : { agent }),
		});
	}

	// Validate dependency graph: unknown references, self-dependencies, and cycles.
	for (const task of tasks) {
		for (const dep of task.dependencies) {
			if (dep === task.id) {
				throw new Error(`Invalid swarm spec: task "${task.id}" depends on itself`);
			}
			if (!seenIds.has(dep)) {
				throw new Error(`Invalid swarm spec: task "${task.id}" depends on unknown task "${dep}"`);
			}
		}
	}

	const byId = new Map(tasks.map(task => [task.id, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (taskId: string): void => {
		if (visited.has(taskId)) return;
		if (visiting.has(taskId)) {
			throw new Error(`Invalid swarm spec: dependency cycle detected involving task "${taskId}"`);
		}
		visiting.add(taskId);
		const task = byId.get(taskId);
		if (task) {
			for (const dep of task.dependencies) {
				visit(dep);
			}
		}
		visiting.delete(taskId);
		visited.add(taskId);
	};

	for (const task of tasks) {
		visit(task.id);
	}

	return tasks;
}

/**
 * Parse and validate a YAML or JSON swarm specification string.
 */
export function parseSwarmSpec(content: string, format: SwarmSpecFormat): SwarmSpec {
	const parsed = parseRawContent(content, format);
	if (!isRecord(parsed)) {
		throw new Error("Invalid swarm spec: root document must be an object");
	}

	const name = readOptionalString(parsed, "name", "swarm spec");
	const goal = readRequiredString(parsed, "goal", "swarm spec");

	let mode: SwarmSpecMode = "dag";
	if (parsed.mode !== undefined) {
		if (parsed.mode !== "dag" && parsed.mode !== "pipeline") {
			throw new Error(`Invalid swarm spec: "mode" must be "dag" or "pipeline", got "${String(parsed.mode)}"`);
		}
		mode = parsed.mode;
	}

	const rawIterations = parsed.iterations ?? parsed.target_count;
	const iterations =
		rawIterations === undefined
			? 1
			: parsePositiveInteger(rawIterations, parsed.iterations !== undefined ? "iterations" : "target_count", 1);

	const rawMaxConcurrency = parsed.maxConcurrency ?? parsed.max_concurrency;
	const maxConcurrency =
		rawMaxConcurrency === undefined ? undefined : parsePositiveInteger(rawMaxConcurrency, "maxConcurrency", 1);

	const rawMaxRetries = parsed.maxRetries ?? parsed.max_retries;
	const maxRetries = rawMaxRetries === undefined ? undefined : parsePositiveInteger(rawMaxRetries, "maxRetries", 0);

	let isolated: boolean | undefined;
	if (parsed.isolated !== undefined) {
		if (typeof parsed.isolated !== "boolean") {
			throw new Error('Invalid swarm spec: "isolated" must be a boolean');
		}
		isolated = parsed.isolated;
	}

	const verificationChecks = readStringArray(parsed, ["verificationChecks", "verification_checks"], "swarm spec");

	const tasks = parseTasks(parsed.tasks);
	const workers = parseWorkers(parsed.workers, isolated ?? false, tasks);

	return {
		...(name === undefined ? {} : { name }),
		goal,
		mode,
		iterations,
		...(maxConcurrency === undefined ? {} : { maxConcurrency }),
		...(maxRetries === undefined ? {} : { maxRetries }),
		...(isolated === undefined ? {} : { isolated }),
		...(verificationChecks === undefined ? {} : { verificationChecks }),
		workers,
		tasks,
	};
}

/**
 * Load and validate a swarm spec from disk (`.yaml`, `.yml`, `.json`, `.json5`).
 */
export async function loadSwarmSpec(filePath: string): Promise<SwarmSpec> {
	const ext = path.extname(filePath).toLowerCase();
	const content = await Bun.file(filePath).text();
	const format: SwarmSpecFormat =
		ext === ".json" || ext === ".json5"
			? "json"
			: ext === ".yaml" || ext === ".yml"
				? "yaml"
				: content.trimStart().startsWith("{")
					? "json"
					: "yaml";
	return parseSwarmSpec(content, format);
}

function slugifyName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9-_]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "swarm";
}

/**
 * Convert a validated `SwarmSpec` into an `OrchestratorPlan`.
 *
 * When `spec.mode === "pipeline"` and tasks do not define explicit dependencies,
 * tasks are chained sequentially in declaration order (`tasks[i]` depends on
 * `tasks[i - 1]`). When `iteration` is provided (1-based), the plan ID and goal
 * reflect that pipeline pass.
 */
export function specToOrchestratorPlan(spec: SwarmSpec, iteration?: number): OrchestratorPlan {
	if (iteration !== undefined && (!Number.isInteger(iteration) || iteration < 1)) {
		throw new Error(`Invalid iteration "${String(iteration)}": must be a positive integer`);
	}

	const baseId = spec.name ? `swarm-${slugifyName(spec.name)}` : `swarm-${Date.now().toString(36)}`;
	const planId =
		iteration !== undefined && (iteration > 1 || spec.iterations > 1) ? `${baseId}-iter-${iteration}` : baseId;
	const goal =
		iteration !== undefined && spec.iterations > 1
			? `${spec.goal} (iteration ${iteration}/${spec.iterations})`
			: spec.goal;

	const autoChainPipeline =
		spec.mode === "pipeline" && spec.tasks.length > 1 && spec.tasks.every(task => task.dependencies.length === 0);

	const tasks: OrchestratorTask[] = spec.tasks.map((task, index) => {
		const prevTask = index > 0 ? spec.tasks[index - 1] : undefined;
		const dependencies = autoChainPipeline && prevTask ? [prevTask.id] : [...task.dependencies];
		return {
			id: task.id,
			title: task.title,
			description: task.description,
			dependencies,
			targetFiles: [...task.targetFiles],
			...(task.agent === undefined ? {} : { agent: task.agent }),
		};
	});

	const workers: WorkerSpec[] = spec.workers.map(worker => ({
		id: worker.id,
		roleLabel: worker.roleLabel,
		backend: worker.backend,
		...(worker.requestedTools === undefined ? {} : { requestedTools: [...worker.requestedTools] }),
		...(worker.model === undefined ? {} : { model: worker.model }),
		...(worker.agent === undefined ? {} : { agent: worker.agent }),
		isolated: worker.isolated,
	}));

	return {
		id: planId,
		goal,
		tasks,
		workers,
		...(spec.maxRetries === undefined ? {} : { maxRetries: spec.maxRetries }),
	};
}
