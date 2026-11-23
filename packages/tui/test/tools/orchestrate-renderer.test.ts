import * as os from "node:os";
import { describe, expect, it } from "bun:test";
import type { TspSpan } from "@marsai-org/wire";
import { getThemeByName } from "@marsai-org/tui/theme";
import { toolRenderers } from "@marsai-org/tui/tools";
import {
	type OrchestrateCallArgs,
	type OrchestrateResultDetails,
	orchestrateToolRenderer,
} from "@marsai-org/tui/tools/orchestrate";
import type { NativeChild, NativeNode } from "../../src/native/node";

const themePromise = getThemeByName("dark");

async function getTheme() {
	const t = await themePromise;
	expect(t).toBeDefined();
	return t!;
}

function plainLines(component: { render: (w: number) => readonly string[] }, width = 120): string[] {
	return component.render(width).map(line => Bun.stripANSI(line));
}

function spansText(spans: string | readonly TspSpan[] | undefined): string {
	if (!spans) return "";
	return typeof spans === "string" ? spans : spans.map(s => s.t).join("");
}

function isNode(child: NativeChild): child is NativeNode {
	return typeof child === "object" && child !== null && "k" in child;
}

function collectText(children: readonly NativeChild[] | undefined): string {
	const parts: string[] = [];
	for (const child of children ?? []) {
		if (!isNode(child)) continue;
		const props = child.p as { text?: string; spans?: readonly TspSpan[]; head?: readonly TspSpan[] } | undefined;
		if (props?.head) parts.push(spansText(props.head));
		if (typeof props?.text === "string") parts.push(props.text);
		if (props?.spans) parts.push(spansText(props.spans));
		if (child.c) parts.push(collectText(child.c));
	}
	return parts.join("\n");
}

describe("orchestrateToolRenderer", () => {
	it("is registered under orchestrate in toolRenderers", () => {
		expect(toolRenderers.orchestrate).toBe(orchestrateToolRenderer);
	});

	it("renders partial/streaming call args gracefully and full call args with shortened paths", async () => {
		const uiTheme = await getTheme();
		const home = os.homedir();

		// Partial / empty args
		const partialComp = orchestrateToolRenderer.renderCall(
			{} as OrchestrateCallArgs,
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		);
		const partialText = plainLines(partialComp).join("\n");
		expect(partialText).toContain("Swarm");

		// Full args with tabs, control chars, and home paths
		const fullArgs: OrchestrateCallArgs = {
			goal: `Refactor\tTUI\x07 in ${home}/mars-agent`,
			workers: [
				{ id: "w1", roleLabel: "tui-worker\t1", agent: "coder", model: "sonnet", isolated: true },
				{ id: "w2", roleLabel: "verifier", agent: "reviewer" },
			],
			tasks: [
				{
					id: "t1",
					title: "Update\tboard\x07",
					agent: "coder",
					targetFiles: [
						`${home}/mars-agent/packages/tui/src/board.ts`,
						`${home}/mars-agent/packages/tui/src/b.ts`,
					],
				},
				{
					id: "t2",
					title: "Verify\trenderer",
					dependencies: ["t1"],
					targetFiles: [`${home}/mars-agent/packages/tui/test/board.test.ts`],
				},
			],
		};

		const fullComp = orchestrateToolRenderer.renderCall(fullArgs, { expanded: false, isPartial: false }, uiTheme);
		const lines = plainLines(fullComp, 140);
		const joined = lines.join("\n");

		expect(joined).toContain("Swarm");
		expect(joined).toContain("2 tasks");
		expect(joined).toContain("2 workers");
		expect(joined).toContain("tui-worker   1");
		expect(joined).toContain("isolated");
		expect(joined).toContain("t1");
		expect(joined).toContain("Update   board");
		expect(joined).toContain("deps: t1");
		expect(joined).toContain("~/mars-agent/packages/tui/src/board.ts");
		expect(joined).not.toContain(home);
		expect(joined).not.toContain("\t");
		expect(joined).not.toContain("\x07");
	});

	it("renders live worker panes when details.panes is present without final outcomes", async () => {
		const uiTheme = await getTheme();
		const home = os.homedir();
		const details: OrchestrateResultDetails = {
			planId: "plan-1",
			panes: [
				{
					workerId: "w1",
					label: "frontend\trole",
					state: "running",
					taskId: "t1",
					taskTitle: "Build\tUI",
					targetFiles: [`${home}/repo/src/ui.ts`],
					elapsedMs: 12_400,
					tokens: 4_250,
					branchName: "swarm/w1",
					attempts: 2,
					currentTool: "edit\tsrc/ui.ts",
					output: ["first\tline", `editing ${home}/repo/src/ui.ts`],
				},
				{
					workerId: "w2",
					label: "backend",
					state: "failed",
					taskId: "t2",
					error: `compile\terror in ${home}/repo/src/api.ts`,
				},
			],
		};

		const comp = orchestrateToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: true, spinnerFrame: 1 },
			uiTheme,
			{ goal: "Live swarm goal" },
		);

		const text = plainLines(comp, 140).join("\n");
		expect(text).toContain("Swarm");
		expect(text).toContain("0/2 workers done");
		expect(text).toContain("1 active");
		expect(text).toContain("1 failed");
		expect(text).toContain("frontend   role (w1)");
		expect(text).toContain("↻2");
		expect(text).toContain("swarm/w1");
		expect(text).toContain("Build   UI");
		expect(text).toContain("~/repo/src/ui.ts");
		expect(text).toContain("4.3K tok");
		expect(text).toContain("⚙ edit   src/ui.ts");
		expect(text).toContain("compile   error in ~/repo/src/api.ts");
		expect(text).not.toContain(home);
		expect(text).not.toContain("\t");
	});

	it("renders settled outcomes with usage, branch, retries, output preview, and verificationFailure", async () => {
		const uiTheme = await getTheme();
		const home = os.homedir();
		const longOutput = Array.from(
			{ length: 8 },
			(_, i) => `step\t${i + 1}: updated ${home}/repo/file-${i + 1}.ts`,
		).join("\n");
		const details: OrchestrateResultDetails = {
			planId: "plan-2",
			stoppedReason: "verification_failed",
			usage: {
				totalTokens: 18_500,
				requests: 14,
				wallClockMs: 45_000,
			},
			outcomes: [
				{
					taskId: "t1",
					state: "completed",
					workerId: "w1",
					branchName: "swarm/t1",
					attempts: 3,
					output: longOutput,
				},
				{
					taskId: "t2",
					state: "failed",
					workerId: "w2",
					exitCode: 1,
					error: "typecheck\tfailed\x07",
					verificationFailure: {
						check: "bun\tcheck",
						output: `error TS2322 in ${home}/repo/src/index.ts\nFound 1 error.`,
					},
				},
			],
		};

		const collapsedComp = orchestrateToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: false, isPartial: false },
			uiTheme,
			{
				goal: "Ship feature",
				tasks: [
					{ id: "t1", title: "Core implementation" },
					{ id: "t2", title: "Typecheck pass" },
				],
			},
		);

		const collapsedText = plainLines(collapsedComp, 140).join("\n");
		expect(collapsedText).toContain("1/2 tasks");
		expect(collapsedText).toContain("1 failed");
		expect(collapsedText).toContain("verification_failed");
		expect(collapsedText).toContain("19K tokens");
		expect(collapsedText).toContain("14 reqs");
		expect(collapsedText).toContain("t1");
		expect(collapsedText).toContain("Core implementation");
		expect(collapsedText).toContain("@w1");
		expect(collapsedText).toContain("swarm/t1");
		expect(collapsedText).toContain("↻3");
		// Collapsed shows tail 3 lines (PREVIEW_LIMITS.OUTPUT_COLLAPSED = 3): steps 6..8, not step 1
		expect(collapsedText).not.toContain("step   1:");
		expect(collapsedText).toContain("step   8:");
		expect(collapsedText).toContain("typecheck   failed");
		expect(collapsedText).toContain("verification failed (bun   check)");
		expect(collapsedText).toContain("error TS2322 in ~/repo/src/index.ts");
		expect(collapsedText).not.toContain(home);
		expect(collapsedText).not.toContain("\t");

		// Expanded view shows up to PREVIEW_LIMITS.OUTPUT_EXPANDED (10) lines, including step 1
		const expandedComp = orchestrateToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: true, isPartial: false },
			uiTheme,
			{ goal: "Ship feature" },
		);
		const expandedText = plainLines(expandedComp, 140).join("\n");
		expect(expandedText).toContain("step   1:");
		expect(expandedText).toContain("step   8:");
	});

	it("renders error-only state cleanly and clamps every row to the terminal width", async () => {
		const uiTheme = await getTheme();
		const home = os.homedir();
		const comp = orchestrateToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "fallback error" }],
				details: {
					stoppedReason: "aborted",
					error: `Fatal\tcycle detected in ${home}/repo/plan.json\x1b[31m`,
				},
				isError: true,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ goal: "Broken\tplan" },
		);

		for (const width of [24, 40, 80, 120]) {
			for (const line of plainLines(comp, width)) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toContain("\t");
			}
		}

		const full = plainLines(comp, 120).join("\n");
		expect(full).toContain("Swarm");
		expect(full).toContain("aborted");
		expect(full).toContain("Fatal   cycle detected in ~/repo/plan.json");
		expect(full).not.toContain(home);
	});

	it("provides structured native TSP views via describeCall and describeResult", () => {
		const home = os.homedir();
		const args: OrchestrateCallArgs = {
			goal: `Native\tgoal ${home}/project`,
			tasks: [{ id: "t1", title: "First\ttask", targetFiles: [`${home}/project/a.ts`] }],
			workers: [{ id: "w1", roleLabel: "builder", isolated: true }],
		};

		const callView = orchestrateToolRenderer.describeCall(args, { expanded: false, isPartial: false });
		const callHead = spansText(callView.head);
		const callBody = collectText(callView.body);
		expect(callHead).toContain("Swarm");
		expect(callHead).toContain("1 task");
		expect(callHead).toContain("1 worker");
		expect(callHead).not.toContain(home);
		expect(callBody).toContain("builder (isolated)");
		expect(callBody).toContain("t1");
		expect(callBody).toContain("~/project/a.ts");

		// Live panes native view
		const liveView = orchestrateToolRenderer.describeResult(
			{
				content: [],
				details: {
					panes: [
						{
							workerId: "w1",
							label: "builder",
							state: "running",
							taskTitle: "First task",
							branchName: "swarm/w1",
							attempts: 2,
							currentTool: "bash",
							output: ["running tests"],
						},
					],
				},
			},
			{ expanded: false, isPartial: true },
			args,
		);
		expect(liveView).toBeDefined();
		expect(spansText(liveView!.head)).toContain("0/1 workers done");
		const liveBody = collectText(liveView!.body);
		expect(liveBody).toContain("builder (w1)");
		expect(liveBody).toContain("↻2");
		expect(liveBody).toContain("swarm/w1");
		expect(liveBody).toContain("⚙ bash");

		// Settled native view
		const settledView = orchestrateToolRenderer.describeResult(
			{
				content: [],
				details: {
					stoppedReason: "completed",
					usage: { totalTokens: 1200, requests: 3, wallClockMs: 5000 },
					outcomes: [
						{
							taskId: "t1",
							state: "failed",
							workerId: "w1",
							branchName: "swarm/t1",
							attempts: 2,
							output: "step done",
							error: "check failed",
							verificationFailure: { check: "bun test", output: "1 failing" },
						},
					],
				},
			},
			{ expanded: false, isPartial: false },
			args,
		);
		expect(settledView).toBeDefined();
		expect(settledView!.tone).toBe("error");
		expect(spansText(settledView!.head)).toContain("0/1 tasks");
		const settledBody = collectText(settledView!.body);
		expect(settledBody).toContain("t1");
		expect(settledBody).toContain("@w1");
		expect(settledBody).toContain("swarm/t1");
		expect(settledBody).toContain("↻2");
		expect(settledBody).toContain("verification failed (bun test)");
		expect(settledBody).toContain("1 failing");

		// Error-only native view
		const errView = orchestrateToolRenderer.describeResult(
			{
				content: [],
				details: { error: "bad\tplan" },
				isError: true,
			},
			{ expanded: false, isPartial: false },
			args,
		);
		expect(errView?.tone).toBe("error");
		expect(collectText(errView?.body)).toContain("bad   plan");
	});
});
