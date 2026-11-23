/**
 * Transcript renderer for the `orchestrate` (swarm) tool: call preview, live
 * per-worker progress rows, settled task outcomes with verification tails, and
 * native TSP `describeCall`/`describeResult` views.
 */
import { pluralize, sanitizeText } from "@marsai-org/utils";
import type { TspSpan, TspTone } from "@marsai-org/wire";
import type { PaneState, WorkerPane } from "../apps/orchestrator-board";
import { compact, node, row, span, text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import type { NativeChild, NativeNode } from "../native/node";
import { renderStatusLine, renderTreeList } from "../render/index";
import {
	Ellipsis,
	formatBadge,
	formatDuration,
	formatNumber,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	type ToolUIColor,
	type ToolUIStatus,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import { errorView, noteText, resultText, toolHead } from "./native-view";
import type {
	NativeToolView,
	RenderResultContextOptions,
	RenderResultOptions,
	ToolActivityContext,
	ToolActivitySummary,
	ToolRenderer,
	ToolRenderResult,
} from "./renderer";

/** Planned task entry from `orchestrate` tool call arguments. */
export interface OrchestratePlannedTask {
	id?: string;
	title?: string;
	dependencies?: string[];
	targetFiles?: string[];
	agent?: string;
}

/** Planned worker entry from `orchestrate` tool call arguments. */
export interface OrchestratePlannedWorker {
	id?: string;
	roleLabel?: string;
	agent?: string;
	model?: string;
	isolated?: boolean;
}

/** Structural call arguments for `orchestrate`. */
export interface OrchestrateCallArgs {
	goal?: string;
	tasks?: OrchestratePlannedTask[];
	workers?: OrchestratePlannedWorker[];
}

/** Verification failure recorded when a task's post-check fails. */
export interface OrchestrateVerificationFailure {
	check: string;
	output: string;
}

/** Settled outcome for a single orchestrated task. */
export interface OrchestrateTaskOutcome {
	taskId: string;
	state: string;
	workerId?: string;
	exitCode?: number;
	output?: string;
	error?: string;
	branchName?: string;
	attempts?: number;
	verificationFailure?: OrchestrateVerificationFailure;
}

/** Aggregate token, request, and wall-clock metrics for a swarm run. */
export interface OrchestrateUsage {
	totalTokens?: number;
	requests?: number;
	wallClockMs?: number;
}

/** Structural `details` payload emitted by the `orchestrate` tool. */
export interface OrchestrateResultDetails {
	planId?: string;
	stoppedReason?: string;
	usage?: OrchestrateUsage;
	outcomes?: OrchestrateTaskOutcome[];
	panes?: readonly WorkerPane[];
	error?: string;
}

/** Sanitize a single-line display fragment: strip ANSI/control chars, expand tabs, collapse newlines, shorten paths. */
function cleanLine(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "";
	return shortenEmbeddedPaths(
		replaceTabs(sanitizeText(value))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
}

/** Sanitize a path for display: `~`-shorten, strip control chars, expand tabs. */
function cleanPath(filePath: unknown): string {
	if (typeof filePath !== "string" || filePath.length === 0) return "";
	return cleanLine(shortenPath(filePath));
}

/** Split multi-line output into sanitized non-empty lines and return the last `limit` lines. */
function cleanTailLines(raw: string | undefined, limit: number): string[] {
	if (typeof raw !== "string" || raw.length === 0 || limit <= 0) return [];
	const normalized = replaceTabs(sanitizeText(raw)).replaceAll("\r\n", "\n").replace(/\r/g, "\n");
	const lines = normalized
		.split("\n")
		.map(line => shortenEmbeddedPaths(line.trimEnd()))
		.filter(line => line.trim().length > 0);
	return lines.slice(-limit);
}

/** Sanitize an array of pre-split output lines and return the last `limit` non-empty lines. */
function cleanArrayTailLines(rawLines: readonly string[] | undefined, limit: number): string[] {
	if (!Array.isArray(rawLines) || rawLines.length === 0 || limit <= 0) return [];
	const lines: string[] = [];
	for (const entry of rawLines) {
		if (typeof entry !== "string") continue;
		for (const part of replaceTabs(sanitizeText(entry)).replaceAll("\r\n", "\n").replace(/\r/g, "\n").split("\n")) {
			const cleaned = shortenEmbeddedPaths(part.trimEnd());
			if (cleaned.trim().length > 0) lines.push(cleaned);
		}
	}
	return lines.slice(-limit);
}

/** Map a pane or outcome state string to a `ToolUIStatus`. */
function toUiStatus(state: string | undefined): ToolUIStatus {
	switch (state) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
		case "aborted":
		case "skipped":
			return "warning";
		case "running":
		case "spawning":
		case "verifying":
		case "merging":
			return "running";
		default:
			return "pending";
	}
}

/** Map a pane or outcome state string to a `ToolUIColor`. */
function toStateColor(state: string | undefined): ToolUIColor {
	switch (state) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
		case "aborted":
		case "skipped":
			return "warning";
		case "running":
		case "spawning":
		case "verifying":
		case "merging":
			return "accent";
		default:
			return "muted";
	}
}

/** Map a pane or outcome state string to a native TSP tone. */
function toNativeTone(state: string | undefined): TspTone {
	switch (state) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
		case "aborted":
		case "skipped":
			return "warning";
		case "running":
		case "spawning":
		case "verifying":
		case "merging":
			return "accent";
		default:
			return "muted";
	}
}

/** Compact glyph for live worker states. */
function paneStateGlyph(state: PaneState | string): string {
	switch (state) {
		case "running":
			return "▶";
		case "spawning":
			return "◐";
		case "verifying":
			return "◇";
		case "merging":
			return "⇄";
		case "completed":
			return "✔";
		case "failed":
			return "✘";
		case "cancelled":
			return "⊘";
		case "idle":
			return "·";
		default:
			return "○";
	}
}

/** Format a list of target files with `shortenPath` and `PREVIEW_LIMITS`. */
function formatTargetFiles(files: readonly unknown[] | undefined, expanded: boolean): string {
	if (!Array.isArray(files) || files.length === 0) return "";
	const cleaned = files.map(cleanPath).filter(Boolean);
	if (cleaned.length === 0) return "";
	const cap = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
	const shown = cleaned.slice(0, cap);
	const remaining = cleaned.length - shown.length;
	return remaining > 0 ? `${shown.join(", ")} (+${remaining} more)` : shown.join(", ");
}

/** Format usage metrics (`totalTokens`, `requests`, `wallClockMs`) into metadata strings. */
function formatUsageParts(usage: OrchestrateUsage | undefined): string[] {
	if (!usage || typeof usage !== "object") return [];
	const parts: string[] = [];
	if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
		parts.push(`${formatNumber(usage.totalTokens)} tokens`);
	}
	if (typeof usage.requests === "number" && Number.isFinite(usage.requests)) {
		parts.push(`${formatNumber(usage.requests)} ${pluralize("req", usage.requests)}`);
	}
	if (typeof usage.wallClockMs === "number" && Number.isFinite(usage.wallClockMs)) {
		parts.push(formatDuration(usage.wallClockMs));
	}
	return parts;
}

/** Wrap a dynamic line builder in a width-clamped TUI Component. */
function linesComponent(buildLines: (width: number) => string[]): Component {
	return {
		render(width: number): readonly string[] {
			const safeWidth = Math.max(1, width);
			return buildLines(safeWidth).map(line => truncateToWidth(line, safeWidth, Ellipsis.Unicode));
		},
		invalidate() {},
	};
}

/** Extract safe array of planned tasks from partial/streamed args. */
function safeTasks(args: OrchestrateCallArgs | undefined): OrchestratePlannedTask[] {
	if (!args || typeof args !== "object" || !Array.isArray(args.tasks)) return [];
	return args.tasks.filter((task): task is OrchestratePlannedTask => typeof task === "object" && task !== null);
}

/** Extract safe array of planned workers from partial/streamed args. */
function safeWorkers(args: OrchestrateCallArgs | undefined): OrchestratePlannedWorker[] {
	if (!args || typeof args !== "object" || !Array.isArray(args.workers)) return [];
	return args.workers.filter(
		(worker): worker is OrchestratePlannedWorker => typeof worker === "object" && worker !== null,
	);
}

/** Resolve the display label for a live worker pane. */
function paneRoleLabel(pane: WorkerPane): string {
	const raw =
		typeof pane.roleLabel === "string" && pane.roleLabel.trim().length > 0
			? pane.roleLabel
			: typeof pane.label === "string" && pane.label.trim().length > 0
				? pane.label
				: pane.workerId;
	return cleanLine(raw) || cleanLine(pane.workerId) || "worker";
}

/** Build the ANSI lines for `renderCall`. */
function buildCallLines(args: OrchestrateCallArgs | undefined, options: RenderResultOptions, uiTheme: Theme): string[] {
	const goalRaw = cleanLine(args?.goal);
	const goalText = goalRaw ? truncateToWidth(goalRaw, TRUNCATE_LENGTHS.TITLE) : undefined;
	const tasks = safeTasks(args);
	const workers = safeWorkers(args);

	const meta: string[] = [];
	if (tasks.length > 0) meta.push(`${tasks.length} ${pluralize("task", tasks.length)}`);
	if (workers.length > 0) meta.push(`${workers.length} ${pluralize("worker", workers.length)}`);

	const header = renderStatusLine(
		{
			icon: options.isPartial ? "running" : "pending",
			spinnerFrame: options.spinnerFrame,
			title: "Swarm",
			description: goalText,
			meta,
		},
		uiTheme,
	);

	const lines: string[] = [header];

	if (workers.length > 0) {
		const workerLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_ITEMS;
		const workerLabels = workers.slice(0, workerLimit).map((worker, idx) => {
			const id = cleanLine(worker.roleLabel ?? worker.id ?? `w${idx + 1}`);
			const details: string[] = [];
			if (worker.agent) details.push(cleanLine(worker.agent));
			if (worker.model) details.push(cleanLine(worker.model));
			if (worker.isolated) details.push("isolated");
			return details.length > 0 ? `${id} (${details.join(", ")})` : id;
		});
		const extraWorkers = workers.length - workerLabels.length;
		const workerSummary =
			extraWorkers > 0 ? `${workerLabels.join(" · ")} · +${extraWorkers} more` : workerLabels.join(" · ");
		lines.push(`  ${uiTheme.fg("dim", `workers: ${workerSummary}`)}`);
	}

	if (tasks.length > 0) {
		const treeLines = renderTreeList(
			{
				items: tasks,
				expanded: options.expanded,
				maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
				itemType: "task",
				renderItem: (task, ctx) => {
					const id = cleanLine(task.id) || `task-${ctx.index + 1}`;
					const title = cleanLine(task.title);
					const headParts: string[] = [uiTheme.fg("accent", id)];
					if (title) {
						headParts.push(uiTheme.fg("muted", truncateToWidth(title, TRUNCATE_LENGTHS.CONTENT)));
					}
					if (task.agent) {
						headParts.push(formatBadge(cleanLine(task.agent), "muted", uiTheme));
					}
					if (Array.isArray(task.dependencies) && task.dependencies.length > 0) {
						const deps = task.dependencies.map(cleanLine).filter(Boolean).join(", ");
						if (deps) headParts.push(uiTheme.fg("dim", `deps: ${deps}`));
					}
					const files = formatTargetFiles(task.targetFiles, Boolean(options.expanded));
					if (files) {
						headParts.push(uiTheme.fg("dim", `[${truncateToWidth(files, TRUNCATE_LENGTHS.CONTENT)}]`));
					}
					return headParts.join(" ");
				},
			},
			uiTheme,
		);
		for (const line of treeLines) lines.push(`  ${line}`);
	}

	return lines;
}

/** Build the ANSI lines for a live `details.panes` snapshot. */
function buildLivePaneLines(
	panes: readonly WorkerPane[],
	details: OrchestrateResultDetails,
	args: OrchestrateCallArgs | undefined,
	options: RenderResultOptions,
	uiTheme: Theme,
): string[] {
	const completed = panes.filter(pane => pane.state === "completed").length;
	const failed = panes.filter(pane => pane.state === "failed").length;
	const running = panes.filter(
		pane =>
			pane.state === "running" ||
			pane.state === "spawning" ||
			pane.state === "verifying" ||
			pane.state === "merging",
	).length;

	const goalRaw = cleanLine(args?.goal);
	const goalText = goalRaw ? truncateToWidth(goalRaw, TRUNCATE_LENGTHS.TITLE) : undefined;

	const meta: string[] = [`${completed}/${panes.length} workers done`];
	if (running > 0) meta.push(`${running} active`);
	if (failed > 0) meta.push(`${failed} failed`);
	meta.push(...formatUsageParts(details.usage));

	const icon: ToolUIStatus =
		failed > 0 && running === 0 ? "error" : running > 0 || options.isPartial ? "running" : "done";
	const header = renderStatusLine(
		{
			icon,
			spinnerFrame: running > 0 ? options.spinnerFrame : undefined,
			title: "Swarm",
			description: goalText,
			badge: details.stoppedReason ? { label: cleanLine(details.stoppedReason), color: "warning" } : undefined,
			meta,
		},
		uiTheme,
	);

	if (panes.length === 0) {
		return [header, `  ${uiTheme.fg("dim", "waiting for workers…")}`];
	}

	const outputLimit = options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
	const treeLines = renderTreeList(
		{
			items: [...panes],
			expanded: options.expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "worker",
			renderItem: pane => {
				const glyph = uiTheme.fg(toStateColor(pane.state), paneStateGlyph(pane.state));
				const role = paneRoleLabel(pane);
				const workerId = cleanLine(pane.workerId);
				const identity = workerId && workerId !== role ? `${role} (${workerId})` : role;
				const parts: string[] = [glyph, uiTheme.fg("accent", identity), uiTheme.fg("dim", cleanLine(pane.state))];

				if (typeof pane.attempts === "number" && pane.attempts > 1) {
					parts.push(formatBadge(`↻${pane.attempts}`, "warning", uiTheme));
				}
				if (pane.branchName) {
					parts.push(formatBadge(cleanLine(pane.branchName), "accent", uiTheme));
				}
				const taskLabel = cleanLine(pane.taskTitle ?? pane.taskId);
				if (taskLabel) {
					parts.push(uiTheme.fg("muted", truncateToWidth(taskLabel, TRUNCATE_LENGTHS.TITLE)));
				}
				const files = formatTargetFiles(pane.targetFiles, Boolean(options.expanded));
				if (files) {
					parts.push(uiTheme.fg("dim", `[${truncateToWidth(files, TRUNCATE_LENGTHS.SHORT)}]`));
				}
				if (typeof pane.elapsedMs === "number" && Number.isFinite(pane.elapsedMs)) {
					parts.push(uiTheme.fg("dim", formatDuration(pane.elapsedMs)));
				}
				if (typeof pane.tokens === "number" && Number.isFinite(pane.tokens)) {
					parts.push(uiTheme.fg("dim", `${formatNumber(pane.tokens)} tok`));
				}

				const itemLines: string[] = [parts.join(" ")];

				if (pane.currentTool) {
					itemLines.push(
						`  ${uiTheme.fg("accent", `⚙ ${truncateToWidth(cleanLine(pane.currentTool), TRUNCATE_LENGTHS.CONTENT)}`)}`,
					);
				}

				const tail = cleanArrayTailLines(pane.output, outputLimit);
				for (const line of tail) {
					itemLines.push(`  ${uiTheme.fg("dim", truncateToWidth(line, TRUNCATE_LENGTHS.LONG))}`);
				}

				if (pane.error) {
					itemLines.push(
						`  ${uiTheme.fg("error", truncateToWidth(cleanLine(pane.error), TRUNCATE_LENGTHS.LINE))}`,
					);
				}

				return itemLines;
			},
		},
		uiTheme,
	);

	return [header, ...treeLines.map(line => `  ${line}`)];
}

/** Build the ANSI lines for settled `details.outcomes`. */
function buildSettledOutcomeLines(
	outcomes: readonly OrchestrateTaskOutcome[],
	details: OrchestrateResultDetails,
	args: OrchestrateCallArgs | undefined,
	options: RenderResultOptions,
	uiTheme: Theme,
	isError: boolean,
): string[] {
	const total = outcomes.length;
	const completed = outcomes.filter(outcome => outcome.state === "completed").length;
	const failed = outcomes.filter(outcome => outcome.state === "failed").length;
	const cancelled = outcomes.filter(
		outcome => outcome.state === "cancelled" || outcome.state === "aborted" || outcome.state === "skipped",
	).length;

	const goalRaw = cleanLine(args?.goal);
	const goalText = goalRaw ? truncateToWidth(goalRaw, TRUNCATE_LENGTHS.TITLE) : undefined;

	const meta: string[] = [`${completed}/${total} tasks`];
	if (failed > 0) meta.push(`${failed} failed`);
	if (cancelled > 0) meta.push(`${cancelled} cancelled`);
	meta.push(...formatUsageParts(details.usage));

	const stoppedReason = cleanLine(details.stoppedReason);
	const badgeColor: ThemeColor =
		isError || failed > 0 ? "error" : stoppedReason && stoppedReason !== "completed" ? "warning" : "success";
	const icon: ToolUIStatus =
		isError || failed > 0
			? "error"
			: cancelled > 0 || (stoppedReason && stoppedReason !== "completed")
				? "warning"
				: "success";

	const header = renderStatusLine(
		{
			icon,
			title: "Swarm",
			description: goalText,
			badge: stoppedReason ? { label: stoppedReason, color: badgeColor } : undefined,
			meta,
		},
		uiTheme,
	);

	const lines: string[] = [header];

	if (details.error) {
		lines.push(`  ${uiTheme.fg("error", truncateToWidth(cleanLine(details.error), TRUNCATE_LENGTHS.LINE))}`);
	}

	const taskTitleById = new Map<string, string>();
	for (const task of safeTasks(args)) {
		const id = cleanLine(task.id);
		const title = cleanLine(task.title);
		if (id && title) taskTitleById.set(id, title);
	}

	const outputLimit = options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
	const treeLines = renderTreeList(
		{
			items: [...outcomes],
			expanded: options.expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "task",
			renderItem: outcome => {
				const taskId = cleanLine(outcome.taskId) || "task";
				const statusIcon = formatStatusIcon(toUiStatus(outcome.state), uiTheme);
				const rowParts: string[] = [statusIcon, uiTheme.fg("accent", taskId)];

				const taskTitle = taskTitleById.get(taskId);
				if (taskTitle) {
					rowParts.push(uiTheme.fg("muted", truncateToWidth(taskTitle, TRUNCATE_LENGTHS.TITLE)));
				}
				if (outcome.workerId) {
					rowParts.push(uiTheme.fg("dim", `@${cleanLine(outcome.workerId)}`));
				}
				if (outcome.branchName) {
					rowParts.push(formatBadge(cleanLine(outcome.branchName), "accent", uiTheme));
				}
				if (typeof outcome.attempts === "number" && outcome.attempts > 1) {
					rowParts.push(formatBadge(`↻${outcome.attempts} (${outcome.attempts} attempts)`, "warning", uiTheme));
				}
				if (typeof outcome.exitCode === "number" && outcome.exitCode !== 0) {
					rowParts.push(formatBadge(`exit ${outcome.exitCode}`, "error", uiTheme));
				}
				rowParts.push(uiTheme.fg(toStateColor(outcome.state), cleanLine(outcome.state) || "unknown"));

				const itemLines: string[] = [rowParts.join(" ")];

				const outputTail = cleanTailLines(outcome.output, outputLimit);
				for (const line of outputTail) {
					itemLines.push(`  ${uiTheme.fg("muted", truncateToWidth(line, TRUNCATE_LENGTHS.LONG))}`);
				}

				if (outcome.error) {
					itemLines.push(
						`  ${uiTheme.fg("error", truncateToWidth(cleanLine(outcome.error), TRUNCATE_LENGTHS.LINE))}`,
					);
				}

				if (outcome.verificationFailure) {
					const check = cleanLine(outcome.verificationFailure.check) || "verification";
					itemLines.push(`  ${uiTheme.fg("error", `✘ verification failed (${check}):`)}`);
					const verifyTail = cleanTailLines(outcome.verificationFailure.output, outputLimit);
					for (const line of verifyTail) {
						itemLines.push(`    ${uiTheme.fg("dim", truncateToWidth(line, TRUNCATE_LENGTHS.LONG))}`);
					}
				}

				return itemLines;
			},
		},
		uiTheme,
	);

	for (const line of treeLines) lines.push(`  ${line}`);
	return lines;
}

/** Native TSP view for `describeCall`. */
function buildNativeCallView(args: OrchestrateCallArgs | undefined): NativeToolView {
	const goal = cleanLine(args?.goal);
	const tasks = safeTasks(args);
	const workers = safeWorkers(args);

	const headDetails: (TspSpan | string | undefined)[] = [
		goal || undefined,
		tasks.length > 0 ? `${tasks.length} ${pluralize("task", tasks.length)}` : undefined,
		workers.length > 0 ? `${workers.length} ${pluralize("worker", workers.length)}` : undefined,
	];
	const head = toolHead("Swarm", ...headDetails);

	const body: NativeChild[] = [];
	if (workers.length > 0) {
		const workerSummary = workers
			.map((w, idx) => {
				const label = cleanLine(w.roleLabel ?? w.id ?? `w${idx + 1}`);
				return w.isolated ? `${label} (isolated)` : label;
			})
			.join(" · ");
		body.push(text([span(`workers: ${workerSummary}`, "dim")], { wrap: "word" }));
	}
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]!;
		const id = cleanLine(task.id) || `task-${i + 1}`;
		const title = cleanLine(task.title);
		const files = formatTargetFiles(task.targetFiles, false);
		const spans: TspSpan[] = [span(id, "accent strong")];
		if (title) spans.push(span(` ${title}`, "muted"));
		if (task.agent) spans.push(span(` [${cleanLine(task.agent)}]`, "dim"));
		if (files) spans.push(span(` (${files})`, "dim"));
		body.push(row([text(spans, { wrap: "word" })], { role: "omp.swarm.task" }));
	}

	return body.length > 0 ? { head, body } : { head };
}

/** Native TSP node for a single live worker pane. */
function describeLivePaneNode(pane: WorkerPane, expanded: boolean): NativeNode {
	const role = paneRoleLabel(pane);
	const workerId = cleanLine(pane.workerId);
	const identity = workerId && workerId !== role ? `${role} (${workerId})` : role;
	const state = cleanLine(pane.state) || "pending";
	const tone = toNativeTone(state);

	const headSpans: TspSpan[] = [
		span(`${paneStateGlyph(pane.state)} `, tone),
		span(identity, "accent strong"),
		span(` ${state}`, "dim"),
	];
	if (typeof pane.attempts === "number" && pane.attempts > 1) {
		headSpans.push(span(` ↻${pane.attempts}`, "warning"));
	}
	if (pane.branchName) {
		headSpans.push(span(` [${cleanLine(pane.branchName)}]`, "accent"));
	}
	const taskLabel = cleanLine(pane.taskTitle ?? pane.taskId);
	if (taskLabel) {
		headSpans.push(span(` · ${taskLabel}`, "muted"));
	}
	const files = formatTargetFiles(pane.targetFiles, expanded);
	if (files) {
		headSpans.push(span(` (${files})`, "dim"));
	}
	if (typeof pane.elapsedMs === "number" && Number.isFinite(pane.elapsedMs)) {
		headSpans.push(span(` · ${formatDuration(pane.elapsedMs)}`, "dim"));
	}
	if (typeof pane.tokens === "number" && Number.isFinite(pane.tokens)) {
		headSpans.push(span(` · ${formatNumber(pane.tokens)} tok`, "dim"));
	}

	const children: NativeChild[] = [];
	if (pane.currentTool) {
		children.push(text([span(`⚙ ${cleanLine(pane.currentTool)}`, "accent")], { wrap: "word" }));
	}
	const limit = expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
	for (const line of cleanArrayTailLines(pane.output, limit)) {
		children.push(text([span(line, "dim")], { wrap: "word" }));
	}
	if (pane.error) {
		children.push(text([span(cleanLine(pane.error), "error")], { wrap: "word" }));
	}

	return node("section", { head: headSpans, role: "omp.swarm.pane", tone }, children, workerId || role);
}

/** Native TSP node for a single settled task outcome. */
function describeOutcomeNode(
	outcome: OrchestrateTaskOutcome,
	taskTitle: string | undefined,
	expanded: boolean,
): NativeNode {
	const taskId = cleanLine(outcome.taskId) || "task";
	const state = cleanLine(outcome.state) || "unknown";
	const tone = toNativeTone(state);

	const headSpans: TspSpan[] = [span(taskId, "accent strong")];
	if (taskTitle) headSpans.push(span(` ${taskTitle}`, "muted"));
	if (outcome.workerId) headSpans.push(span(` @${cleanLine(outcome.workerId)}`, "dim"));
	if (outcome.branchName) headSpans.push(span(` [${cleanLine(outcome.branchName)}]`, "accent"));
	if (typeof outcome.attempts === "number" && outcome.attempts > 1) {
		headSpans.push(span(` ↻${outcome.attempts}`, "warning"));
	}
	headSpans.push(span(` ${state}`, tone));

	const limit = expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
	const children: NativeChild[] = [];
	for (const line of cleanTailLines(outcome.output, limit)) {
		children.push(text([span(line, "muted")], { wrap: "word" }));
	}
	if (outcome.error) {
		children.push(text([span(cleanLine(outcome.error), "error")], { wrap: "word" }));
	}
	if (outcome.verificationFailure) {
		const check = cleanLine(outcome.verificationFailure.check) || "verification";
		children.push(text([span(`verification failed (${check})`, "error strong")], { wrap: "word" }));
		for (const line of cleanTailLines(outcome.verificationFailure.output, limit)) {
			children.push(text([span(line, "dim")], { wrap: "word" }));
		}
	}

	return node("section", { head: headSpans, role: "omp.swarm.outcome", tone }, children, taskId);
}

/** Native TSP view for `describeResult`. */
function buildNativeResultView(
	result: ToolRenderResult<OrchestrateResultDetails>,
	options: RenderResultOptions,
	args?: OrchestrateCallArgs,
): NativeToolView {
	const details = result.details;
	const goal = cleanLine(args?.goal);
	const hasOutcomes = Array.isArray(details?.outcomes) && details.outcomes.length > 0;
	const hasPanes = Array.isArray(details?.panes) && details.panes.length > 0;

	if (!hasOutcomes && !hasPanes && (result.isError || details?.error)) {
		const message = cleanLine(details?.error) || cleanLine(resultText(result)) || "Swarm execution failed";
		return errorView("Swarm", message, goal || undefined);
	}

	if (!details) {
		const fallback = cleanLine(resultText(result));
		return {
			head: toolHead("Swarm", goal || undefined),
			body: fallback ? [noteText(fallback)] : [],
		};
	}

	// Live state: panes present, no settled outcomes yet.
	if (Array.isArray(details.panes) && !hasOutcomes) {
		const panes = details.panes;
		const completed = panes.filter(pane => pane.state === "completed").length;
		const failed = panes.filter(pane => pane.state === "failed").length;
		const summary = `${completed}/${panes.length} workers done`;
		const usageMeta = formatUsageParts(details.usage).join(" · ");
		const head = toolHead(
			"Swarm",
			goal || undefined,
			summary,
			details.stoppedReason ? cleanLine(details.stoppedReason) : undefined,
			usageMeta || undefined,
		);
		const body =
			panes.length > 0
				? panes.map(pane => describeLivePaneNode(pane, Boolean(options.expanded)))
				: [noteText("waiting for workers…")];
		return {
			head,
			tone: failed > 0 ? "error" : "accent",
			body,
		};
	}

	// Settled outcomes state.
	const outcomes = details.outcomes ?? [];
	const completed = outcomes.filter(outcome => outcome.state === "completed").length;
	const failed = outcomes.filter(outcome => outcome.state === "failed").length;
	const summary = `${completed}/${outcomes.length} tasks`;
	const stoppedReason = cleanLine(details.stoppedReason);
	const usageMeta = formatUsageParts(details.usage).join(" · ");

	const head: TspSpan[] = [
		...toolHead("Swarm", goal || undefined, summary, usageMeta || undefined),
		...(stoppedReason
			? [span(" "), span(stoppedReason, failed > 0 || result.isError ? "error strong" : "accent strong")]
			: []),
	];

	const taskTitleById = new Map<string, string>();
	for (const task of safeTasks(args)) {
		const id = cleanLine(task.id);
		const title = cleanLine(task.title);
		if (id && title) taskTitleById.set(id, title);
	}

	const body: NativeChild[] = compact([
		details.error ? text([span(cleanLine(details.error), "error")], { wrap: "word" }) : undefined,
		...outcomes.map(outcome =>
			describeOutcomeNode(outcome, taskTitleById.get(cleanLine(outcome.taskId)), Boolean(options.expanded)),
		),
	]);

	return {
		head,
		tone:
			result.isError || failed > 0
				? "error"
				: stoppedReason && stoppedReason !== "completed"
					? "warning"
					: "success",
		body,
	};
}

const callMemo = new OwnerMemo<NativeToolView | undefined>();
const resultMemo = new OwnerMemo<NativeToolView | undefined>();

/** First-class TUI renderer for the `orchestrate` (swarm) tool. */
export const orchestrateToolRenderer = {
	mergeCallAndResult: true,
	animatedPendingPreview: true,
	animatedPartialResult: true,

	activitySummary(args: OrchestrateCallArgs, _context: ToolActivityContext): ToolActivitySummary {
		const goal = cleanLine(args?.goal);
		return {
			label: "Swarm",
			detail: goal ? truncateToWidth(goal, TRUNCATE_LENGTHS.TITLE) : undefined,
		};
	},

	renderCall(args: OrchestrateCallArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		return linesComponent(() => buildCallLines(args, options, uiTheme));
	},

	renderResult(
		result: ToolRenderResult<OrchestrateResultDetails>,
		options: RenderResultContextOptions,
		uiTheme: Theme,
		args?: OrchestrateCallArgs,
	): Component {
		return linesComponent(() => {
			const details = result.details;
			const hasOutcomes = Array.isArray(details?.outcomes) && details.outcomes.length > 0;
			const hasPanes = Array.isArray(details?.panes);

			// Error-only state: details.error or result.isError without outcomes or panes.
			if (!hasOutcomes && !hasPanes && (details?.error || result.isError)) {
				const goalRaw = cleanLine(args?.goal);
				const goalText = goalRaw ? truncateToWidth(goalRaw, TRUNCATE_LENGTHS.TITLE) : undefined;
				const header = renderStatusLine(
					{
						icon: "error",
						title: "Swarm",
						description: goalText,
						badge: details?.stoppedReason
							? { label: cleanLine(details.stoppedReason), color: "error" }
							: undefined,
					},
					uiTheme,
				);
				const rawError = details?.error ?? resultText(result) ?? "Swarm execution failed";
				const errLines = cleanTailLines(rawError, PREVIEW_LIMITS.EXPANDED_LINES);
				const displayErrors =
					errLines.length > 0
						? errLines.map(line => `  ${uiTheme.fg("error", truncateToWidth(line, TRUNCATE_LENGTHS.LINE))}`)
						: [`  ${uiTheme.fg("error", "Swarm execution failed")}`];
				return [header, ...displayErrors];
			}

			// Live panes state (when panes are present and no final outcomes yet).
			if (details && Array.isArray(details.panes) && !hasOutcomes) {
				return buildLivePaneLines(details.panes, details, args, options, uiTheme);
			}

			// Settled outcomes state.
			if (details && Array.isArray(details.outcomes)) {
				return buildSettledOutcomeLines(details.outcomes, details, args, options, uiTheme, Boolean(result.isError));
			}

			// Fallback when details has neither outcomes nor panes.
			const goalRaw = cleanLine(args?.goal);
			const goalText = goalRaw ? truncateToWidth(goalRaw, TRUNCATE_LENGTHS.TITLE) : undefined;
			const header = renderStatusLine(
				{
					icon: result.isError ? "error" : "done",
					title: "Swarm",
					description: goalText,
				},
				uiTheme,
			);
			const fallback = cleanLine(resultText(result));
			return fallback
				? [
						header,
						`  ${uiTheme.fg(result.isError ? "error" : "muted", truncateToWidth(fallback, TRUNCATE_LENGTHS.LINE))}`,
					]
				: [header];
		});
	},

	describeCall(args: OrchestrateCallArgs, _options: RenderResultOptions): NativeToolView {
		const tasks = safeTasks(args);
		const workers = safeWorkers(args);
		if (!args || typeof args !== "object") return buildNativeCallView(args);
		return (
			callMemo.get(args, [args.goal, tasks.length, workers.length], () => buildNativeCallView(args)) ??
			buildNativeCallView(args)
		);
	},

	describeResult(
		result: ToolRenderResult<OrchestrateResultDetails>,
		options: RenderResultContextOptions,
		args?: OrchestrateCallArgs,
	): NativeToolView | undefined {
		return resultMemo.get(
			result,
			[
				options.expanded,
				options.isPartial,
				args?.goal,
				result.details?.outcomes?.length,
				result.details?.panes?.length,
			],
			() => buildNativeResultView(result, options, args),
		);
	},
} satisfies ToolRenderer<OrchestrateCallArgs, OrchestrateResultDetails>;
