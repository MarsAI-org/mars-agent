import { stripVTControlCharacters } from "node:util";
import { type AgentMessage, ThinkingLevel } from "@marsai-org/agent-core";
import * as vcs from "@marsai-org/natives/vcs";
import { chatTranscriptDisplayPreferences, type LayoutDensity } from "../chat/display-preferences";
import { type Component, Ellipsis, padding, replaceTabs, sliceByColumn, truncateToWidth, visibleWidth } from "../index";
import { formatNumber, getProjectDir } from "@marsai-org/utils";
import { theme } from "../theme";
import type { FooterHost, FooterSession } from "./host";
import { shortenPath } from "../render/render-utils";
import { sanitizeStatusText } from "../chrome/shared";
import { formatMetric } from "../components/metric";
import { formatBillingSummary } from "./metrics";
import {
	formatContextUsage,
	getContextUsageLevel,
	getContextUsageThemeColor,
	getContextUsageTone,
} from "../chrome/context-thresholds";
import type { TspProps, TspSpan } from "@marsai-org/wire";
import type { NativeNode } from "../native/node";
import { col, node, span } from "../native/describe";

interface UsageTotals {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	totalPremiumRequests: number;
}

interface UsagePrefixMemo {
	entriesRef: readonly { type: string; message?: AgentMessage }[];
	prefixLength: number;
	firstEntry: { type: string; message?: AgentMessage } | undefined;
	totals: UsageTotals;
}

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent implements Component {
	#cachedBranch: string | null | undefined = undefined;
	#branchResolve: AbortController | undefined;
	#branchGeneration = 0;
	#gitUnwatch: (() => void) | null = null;
	#onBranchChange: (() => void) | null = null;
	#disposed = false;
	#autoCompactEnabled: boolean = true;
	#extensionStatuses: Map<string, string> = new Map();
	#nativeMemo: { node: NativeNode; fingerprint: string } | undefined;
	#usagePrefixMemo: UsagePrefixMemo | undefined;
	#density: LayoutDensity | undefined;

	constructor(
		private readonly session: FooterSession,
		private readonly host: FooterHost,
	) {}

	setDensity(density: LayoutDensity | undefined): void {
		this.#density = density;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	/**
	 * Set extension status text to display in the footer.
	 * ANSI/VT escape sequences and most control characters are stripped; tabs and newlines become spaces.
	 * The combined status line is trimmed and truncated to terminal width.
	 * @param key - Unique key to identify this status
	 * @param text - Status text, or undefined to clear
	 */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#extensionStatuses.delete(key);
		} else {
			this.#extensionStatuses.set(key, text);
		}
	}

	/**
	 * Watch the repository head for label changes and repaint the footer.
	 */
	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		this.#gitUnwatch?.();
		this.#gitUnwatch = null;

		if (!this.host.gitEnabled()) return;
		const repository = vcs.repoForDisplay(getProjectDir());
		if (!repository) return;

		try {
			this.#gitUnwatch = vcs.watch(repository, () => {
				this.#invalidateBranch();
				this.#onBranchChange?.();
			});
		} catch {
			// Silently fail if we can't watch
		}
	}

	/**
	 * Clean up the file watcher
	 */
	dispose(): void {
		this.#disposed = true;
		this.#branchResolve?.abort();
		this.#branchResolve = undefined;
		this.#gitUnwatch?.();
		this.#gitUnwatch = null;
	}

	invalidate(): void {
		this.#invalidateBranch();
	}

	#invalidateBranch(): void {
		this.#branchGeneration++;
		this.#branchResolve?.abort();
		this.#branchResolve = undefined;
		this.#cachedBranch = undefined;
	}

	/**
	 * Get the current branch, bookmark, or change-id label.
	 */
	#getCurrentBranch(): string | null {
		if (!this.host.gitEnabled()) return null;
		if (this.#cachedBranch !== undefined) {
			return this.#cachedBranch;
		}

		const repository = (() => {
			try {
				return vcs.repoForDisplay(getProjectDir());
			} catch {
				return null;
			}
		})();
		if (!repository) {
			this.#cachedBranch = null;
			return null;
		}

		const gitRepository = repository.asGit();
		if (!gitRepository) {
			if (!this.#branchResolve) {
				const request = new AbortController();
				const generation = this.#branchGeneration;
				this.#branchResolve = request;
				void repository
					.label(request.signal)
					.then(label => {
						if (this.#disposed || this.#branchGeneration !== generation) return;
						const clean = typeof label === "string" ? sanitizeStatusText(label) : label;
						const changed = this.#cachedBranch !== clean;
						this.#cachedBranch = clean;
						if (changed) this.#onBranchChange?.();
					})
					.catch(() => {
						if (this.#disposed || this.#branchGeneration !== generation) return;
						this.#cachedBranch = null;
					})
					.finally(() => {
						if (this.#branchResolve === request) this.#branchResolve = undefined;
					});
			}
			return this.#cachedBranch ?? null;
		}

		const headState = (() => {
			try {
				return gitRepository.headSync();
			} catch {
				return null;
			}
		})();
		const rawBranch =
			headState === null
				? null
				: headState.kind === "ref"
					? (headState.branch ?? headState.refName ?? "HEAD")
					: "detached";
		this.#cachedBranch = typeof rawBranch === "string" ? sanitizeStatusText(rawBranch) : rawBranch;
		return this.#cachedBranch;
	}

	/**
	 * Native footer: a `status` bar (path and branch, usage counters, billing
	 * and context on the left, model on the right) plus the extension statuses.
	 * Rebuilt per call from cheap session reads; the node identity holds while
	 * the description is unchanged.
	 */
	describe(): NativeNode {
		const state = this.session.state;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		let premiumRequests = 0;
		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message?.role === "assistant") {
				input += entry.message.usage.input;
				output += entry.message.usage.output;
				cacheRead += entry.message.usage.cacheRead;
				cacheWrite += entry.message.usage.cacheWrite;
				cost += entry.message.usage.cost.total;
				premiumRequests += entry.message.usage.premiumRequests ?? 0;
			}
		}
		const segs: NativeNode[] = [];
		const seg = (key: string, props: TspProps<"seg">): void => {
			segs.push(node("seg", { role: `omp.footer.${key}`, ...props }, undefined, key));
		};
		const isAscii = theme.getSymbolPreset() === "ascii";
		const pathSpans: TspSpan[] = [span(replaceTabs(shortenPath(getProjectDir())), "path dim")];
		const branch = this.#getCurrentBranch();
		if (branch) pathSpans.push(span(` (${replaceTabs(branch)})`, "dim"));
		seg("path", { side: "left", priority: 6, icon: "folder", spans: pathSpans });
		const counters: [string, string, number][] = [
			["input", isAscii ? theme.icon.input : "↑", input],
			["output", isAscii ? theme.icon.output : "↓", output],
			["cache-read", "R", cacheRead],
			["cache-write", "W", cacheWrite],
		];
		for (const [key, glyph, amount] of counters) {
			if (amount) seg(key, { side: "left", priority: 1, spans: [span(`${glyph}${formatNumber(amount)}`, "dim")] });
		}
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		const billing = formatBillingSummary({ cost, usingSubscription, premiumRequests, fractionDigits: 3 }, theme);
		if (billing) seg("cost", { side: "left", priority: 3, spans: [span(billing, "dim")] });
		const tokensPerSecond = this.session.getTokensPerSecond?.() ?? null;
		if (tokensPerSecond && tokensPerSecond > 0) {
			seg("rate", {
				side: "left",
				priority: 2,
				spans: [span(`${tokensPerSecond.toFixed(1)} tok/s`, "dim")],
			});
		}
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercent = contextWindow > 0 ? (contextUsage?.percent ?? 0) : null;
		const level =
			contextUsage && contextPercent !== null ? getContextUsageLevel(contextPercent, contextWindow) : "normal";
		const contextSpans: TspSpan[] = [
			span(
				formatContextUsage(contextPercent, contextWindow, contextUsage?.tokens ?? 0),
				getContextUsageThemeColor(level),
			),
		];
		if (this.#autoCompactEnabled && theme.icon.auto) contextSpans.push(span(` ${theme.icon.auto}`, "dim"));
		const contextProps: TspProps<"seg"> = { side: "left", priority: 4, icon: "context", spans: contextSpans };
		const tone = getContextUsageTone(level);
		if (tone) contextProps.tone = tone;
		seg("context", contextProps);
		let model = state.model?.id || "no-model";
		if (state.model?.thinking) {
			const level = this.session.isAutoThinking
				? (this.session.autoResolvedThinkingLevel() ?? `${theme.thinking.autoPending} auto`)
				: (state.thinkingLevel ?? ThinkingLevel.Off);
			model += `${isAscii ? theme.sep.dot : " • "}${level}`;
		}
		seg("model", { side: "right", priority: 5, icon: "model", spans: [span(model, "dim")] });
		const bar = node("status", { role: "omp.footer" }, segs, "bar");
		const children: NativeNode[] = [bar];
		if (this.#extensionStatuses.size > 0) {
			const statuses = Array.from(this.#extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, value]) => sanitizeStatusText(value))
				.join(" ");
			children.push(node("text", { text: statuses, wrap: "none", role: "omp.footer.extensions" }, undefined, "ext"));
		}
		const built = children.length === 1 ? bar : col(children, { role: "omp.footer.panel" });
		const fingerprint = JSON.stringify(built);
		if (this.#nativeMemo?.fingerprint === fingerprint) return this.#nativeMemo.node;
		this.#nativeMemo = { node: built, fingerprint };
		return built;
	}

	#computeUsageTotals(): UsageTotals {
		const entries = this.session.sessionManager.getEntries();
		const prefixLen = Math.max(0, entries.length - 1);
		const firstEntry = entries[0];
		const memo = this.#usagePrefixMemo;

		let totals: UsageTotals;
		let startIdx = 0;
		if (
			memo !== undefined &&
			memo.firstEntry === firstEntry &&
			memo.prefixLength <= prefixLen &&
			(memo.entriesRef === entries || memo.prefixLength > 0)
		) {
			totals = { ...memo.totals };
			startIdx = memo.prefixLength;
		} else {
			totals = {
				totalInput: 0,
				totalOutput: 0,
				totalCacheRead: 0,
				totalCacheWrite: 0,
				totalCost: 0,
				totalPremiumRequests: 0,
			};
		}

		for (let i = startIdx; i < prefixLen; i++) {
			const entry = entries[i];
			if (entry?.type === "message" && entry.message?.role === "assistant") {
				totals.totalInput += entry.message.usage.input;
				totals.totalOutput += entry.message.usage.output;
				totals.totalCacheRead += entry.message.usage.cacheRead;
				totals.totalCacheWrite += entry.message.usage.cacheWrite;
				totals.totalCost += entry.message.usage.cost.total;
				totals.totalPremiumRequests += entry.message.usage.premiumRequests ?? 0;
			}
		}

		this.#usagePrefixMemo = {
			entriesRef: entries,
			prefixLength: prefixLen,
			firstEntry,
			totals: { ...totals },
		};

		const lastEntry = entries[prefixLen];
		if (lastEntry?.type === "message" && lastEntry.message?.role === "assistant") {
			totals.totalInput += lastEntry.message.usage.input;
			totals.totalOutput += lastEntry.message.usage.output;
			totals.totalCacheRead += lastEntry.message.usage.cacheRead;
			totals.totalCacheWrite += lastEntry.message.usage.cacheWrite;
			totals.totalCost += lastEntry.message.usage.cost.total;
			totals.totalPremiumRequests += lastEntry.message.usage.premiumRequests ?? 0;
		}

		return totals;
	}

	render(width: number): readonly string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost, totalPremiumRequests } =
			this.#computeUsageTotals();

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextTokens = contextUsage?.tokens ?? 0;
		const contextPercentValue = contextWindow > 0 ? (contextUsage?.percent ?? 0) : null;

		const isAscii = theme.getSymbolPreset() === "ascii";

		// Replace home directory with ~
		let pwd = replaceTabs(shortenPath(getProjectDir()));

		// Add git branch if available
		const branch = this.#getCurrentBranch();
		if (branch) {
			pwd = `${pwd} (${replaceTabs(branch)})`;
		}

		// Truncate path if too long to fit width (by terminal cells, not UTF-16 code units)
		const pwdWidth = visibleWidth(pwd);
		if (pwdWidth > width) {
			const ellipsis = isAscii ? "..." : "…";
			const ellipsisWidth = visibleWidth(ellipsis);
			const available = width - ellipsisWidth;
			const startWidth = Math.floor(available / 2);
			const endWidth = available - startWidth;
			if (startWidth > 0 && endWidth > 0) {
				const start = sliceByColumn(pwd, 0, startWidth, true);
				const end = sliceByColumn(pwd, pwdWidth - endWidth, endWidth, true);
				pwd = `${start}${ellipsis}${end}`;
			} else {
				pwd = truncateToWidth(pwd, Math.max(0, width), Ellipsis.Omit);
			}
		}

		// Build stats line
		const statsParts: string[] = [];
		for (const [glyph, amount] of [
			[isAscii ? theme.icon.input : "↑", totalInput],
			[isAscii ? theme.icon.output : "↓", totalOutput],
			["R", totalCacheRead],
			["W", totalCacheWrite],
		] as const) {
			const part = formatMetric({
				leading: glyph,
				separator: "",
				value: amount ? formatNumber(amount) : undefined,
			});
			if (part !== undefined) statsParts.push(part);
		}

		// Show billing summary with subscription and premium-request indicators
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		const { auto: autoIcon } = theme.icon;
		const billing = formatBillingSummary(
			{ cost: totalCost, usingSubscription, premiumRequests: totalPremiumRequests, fractionDigits: 3 },
			theme,
		);
		if (billing) statsParts.push(billing);
		const tokensPerSecond = this.session.getTokensPerSecond?.() ?? null;
		if (tokensPerSecond && tokensPerSecond > 0) {
			const rateMetric = formatMetric({
				leading: isAscii ? undefined : theme.icon.throughput || undefined,
				value: `${tokensPerSecond.toFixed(1)} tok/s`,
			});
			if (rateMetric) statsParts.push(rateMetric);
		}
		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.#autoCompactEnabled && autoIcon ? ` ${autoIcon}` : "";
		const contextPercentDisplay = `${formatContextUsage(contextPercentValue, contextWindow, contextTokens)}${autoIndicator}`;
		if (contextUsage && contextPercentValue !== null) {
			const color = getContextUsageThemeColor(getContextUsageLevel(contextPercentValue, contextWindow));
			contextPercentStr =
				color === "statusLineContext" ? contextPercentDisplay : theme.fg(color, contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = sanitizeStatusText(state.model?.id || "no-model");
		const fastSuffix = !isAscii && this.session.isFastModeActive?.() && theme.icon.fast ? ` ${theme.icon.fast}` : "";

		// Add thinking level hint when the current model advertises supported efforts
		let rightSide = `${modelName}${fastSuffix}`;
		if (state.model?.thinking) {
			const sep = isAscii ? theme.sep.dot : " • ";
			if (this.session.isAutoThinking) {
				// Pending (no turn classified yet / classifying) shows a symbol-theme
				// question-box marker; once resolved it shows `<level>`.
				const resolved = this.session.autoResolvedThinkingLevel();
				rightSide = `${modelName}${fastSuffix}${sep}${resolved ? resolved : `${theme.thinking.autoPending} auto`}`;
			} else {
				const thinkingLevel = state.thinkingLevel ?? ThinkingLevel.Off;
				rightSide = `${modelName}${fastSuffix}${sep}${thinkingLevel}`;
			}
		}

		let statsLeftWidth = visibleWidth(statsLeft);
		const rightSideWidth = visibleWidth(rightSide);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			// Drop styling and truncate by terminal cells (not code points) so wide
			// glyphs and non-SGR escapes can't overflow the line.
			statsLeft = truncateToWidth(stripVTControlCharacters(statsLeft), width);
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const pad = padding(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + pad + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 3) {
				// Drop styling and truncate by terminal cells so the right side fits.
				const truncatedRight = truncateToWidth(stripVTControlCharacters(rightSide), availableForRight);
				const pad = padding(width - statsLeftWidth - visibleWidth(truncatedRight));
				statsLine = statsLeft + pad + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);
		const statsRow = dimStatsLeft + dimRemainder;

		const density = this.#density ?? chatTranscriptDisplayPreferences.density;
		let lines: string[];
		if (density === "compact") {
			const sep = isAscii ? " | " : theme.sep.dot;
			const combinedLeft = `${pwd}${sep}${statsLeft}`;
			const combinedLeftWidth = visibleWidth(combinedLeft);
			if (combinedLeftWidth + minPadding + rightSideWidth <= width) {
				const pad = padding(width - combinedLeftWidth - rightSideWidth);
				lines = [`${theme.fg("dim", `${pwd}${sep}`)}${dimStatsLeft}${theme.fg("dim", `${pad}${rightSide}`)}`];
			} else {
				lines = [theme.fg("dim", pwd), statsRow];
			}
		} else {
			lines = [theme.fg("dim", pwd), statsRow];
		}

		// Add extension statuses on a single line, sorted by key alphabetically
		if (this.#extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(this.#extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width));
		}

		return lines;
	}
}
