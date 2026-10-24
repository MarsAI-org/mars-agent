import { describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { type Element, parseHTML } from "@marsai-org/utils/dom";

const [templateHtml, templateJs, markedJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/vendor/marked.min.js", import.meta.url)).text(),
]);

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface MessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user" | "assistant";
		content: string | unknown[];
		timestamp: number;
		provider?: string;
		model?: string;
		usage?: Usage;
	};
}

interface BranchSummaryEntry {
	type: "branch_summary";
	id: string;
	parentId: string | null;
	timestamp: string;
	summary: string;
}

type Entry = MessageEntry | BranchSummaryEntry;

const usage = (input: number, output: number, cost: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function renderHeader(entries: Entry[], leafId: string): string {
	const session = {
		header: { type: "session", version: 3, id: "stats-test", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
		entries,
		leafId,
	};
	const { document, window } = parseHTML(templateHtml);
	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(JSON.stringify(session)).toBase64();
	Object.defineProperty(window, "location", {
		value: new URL("https://example.test/export.html"),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});
	const themeSelect = document.getElementById("theme-select");
	if (themeSelect) {
		let themeValue = "auto";
		Object.defineProperty(themeSelect, "value", {
			get: () => themeValue,
			set: next => {
				themeValue = String(next);
			},
			configurable: true,
		});
	}
	const context = vm.createContext({
		window,
		document,
		hljs: { getLanguage: () => false, highlight: () => ({ value: "" }), highlightAuto: () => ({ value: "" }) },
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		navigator: { clipboard: null },
		localStorage: { getItem: () => null, setItem() {} },
		setTimeout: () => 0,
		clearTimeout() {},
	});
	vm.runInContext(markedJs, context);
	vm.runInContext("marked = new marked.Marked()", context);
	vm.runInContext(templateJs, context);
	const header = document.getElementById("header-container") as Element | null;
	if (!header) throw new Error("Export viewer did not render a header");
	return header.textContent ?? "";
}

const user = (id: string, parentId: string | null): MessageEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: "hi", timestamp: 0 },
});
const assistant = (id: string, parentId: string, tokens: Usage): MessageEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		timestamp: 0,
		provider: "gw",
		model: "gw-chat",
		usage: tokens,
	},
});

describe("HTML export header stats", () => {
	test("counts only the branch the reader lands on", () => {
		const entries: Entry[] = [
			user("u1", null),
			assistant("a1", "u1", usage(900_000, 20, 9)),
			{
				type: "branch_summary",
				id: "b1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:00.000Z",
				summary: "rewound",
			},
			user("u2", "b1"),
			assistant("a2", "u2", usage(100, 10, 0.01)),
		];

		const header = renderHeader(entries, "a2");

		expect(header).toContain("$0.010");
		expect(header).not.toContain("$9.010");
		expect(header).toContain("↑100");
	});

	test("reports a provider total when the per-bucket prices are zero", () => {
		const totalOnly = usage(1000, 100, 0);
		totalOnly.cost.total = 0.42;

		const header = renderHeader([user("u1", null), assistant("a1", "u1", totalOnly)], "a1");

		expect(header).toContain("$0.420");
	});
});
