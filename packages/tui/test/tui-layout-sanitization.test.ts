import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as utils from "@marsai-org/utils";
import { dividerSplit, splitRow, topBorderSplit } from "../src/chrome/overlay-box";
import { OAuthSelectorComponent, type OAuthSelectorAuthSource } from "../src/overlays/oauth-selector";
import { UsageDashboardComponent } from "../src/overlays/usage-dashboard";
import { FooterComponent } from "../src/status-line/footer";
import { initTheme, setSymbolPreset, theme } from "../src/theme/theme";
import { astGrepToolRenderer } from "../src/tools/ast-grep";
import { BashInteractiveOverlayComponent } from "../src/tools/bash-interactive";
import { renderSearchResult } from "../src/tools/web-search";
import { setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { MessageDividerComponent } from "../src/chrome/message-divider";
import { visibleWidth } from "../src/utils";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await setSymbolPreset("unicode");
});

describe("FooterComponent cell-width truncation and ASCII symbols", () => {
	function makeFooter() {
		const session = {
			state: {
				model: { id: "claude-test", contextWindow: 100_000, thinking: true },
				thinkingLevel: "high",
			},
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			getContextUsage: () => ({ tokens: 25_000, contextWindow: 100_000, percent: 25 }),
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getEntries: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 1200, output: 340, cacheRead: 100, cacheWrite: 50, cost: { total: 0.012 } },
						},
					},
				],
			},
		} as unknown as ConstructorParameters<typeof FooterComponent>[0];
		const host = { gitEnabled: () => false } as unknown as ConstructorParameters<typeof FooterComponent>[1];
		return new FooterComponent(session, host);
	}

	it("sanitizes tabs in pwd and truncates wide CJK paths by cell width", () => {
		vi.spyOn(utils, "getProjectDir").mockReturnValue(`/tmp/\t${"日本語".repeat(12)}/end`);
		const footer = makeFooter();
		for (const width of [6, 12, 20, 32]) {
			const [pwdLine] = footer.render(width);
			expect(pwdLine).not.toContain("\t");
			expect(visibleWidth(pwdLine!)).toBeLessThanOrEqual(width);
		}
		footer.dispose();
	});

	it("uses ASCII-safe symbols instead of hardcoded Unicode arrows and bullets under the ascii preset", async () => {
		await setSymbolPreset("ascii");
		const footer = makeFooter();
		const lines = footer.render(100).map(l => Bun.stripANSI(l));
		const stats = lines[1]!;
		expect(stats).toContain("in:1.2K");
		expect(stats).toContain("out:340");
		expect(stats).toContain("claude-test - high");
		expect(stats).not.toMatch(/[↑↓•]/);
		footer.dispose();
	});

	it("updates cumulative usage accurately across appended, mutated-last, and rewound entries", () => {
		const entries: Array<{ type: string; message?: Record<string, unknown> }> = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			},
		];
		const session = {
			state: { model: { id: "claude-test", contextWindow: 100_000, thinking: false }, thinkingLevel: "off" },
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => entries },
		} as unknown as ConstructorParameters<typeof FooterComponent>[0];
		const host = { gitEnabled: () => false } as unknown as ConstructorParameters<typeof FooterComponent>[1];
		const footer = new FooterComponent(session, host);

		// Initial render: 1K in, 200 out
		expect(Bun.stripANSI(footer.render(120)[1]!)).toContain("↑1K ↓200");

		// Mutate last entry in-place (streaming)
		(entries[0]!.message!.usage as Record<string, unknown>).output = 500;
		expect(Bun.stripANSI(footer.render(120)[1]!)).toContain("↑1K ↓500");

		// Append new entry
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			},
		});
		expect(Bun.stripANSI(footer.render(120)[1]!)).toContain("↑1.5K ↓600");

		// Rewind (shrink entries)
		entries.pop();
		expect(Bun.stripANSI(footer.render(120)[1]!)).toContain("↑1K ↓500");

		// Compact density collapses pwd + stats onto one row when it fits
		footer.setDensity("compact");
		const compactLines = footer.render(160);
		expect(compactLines.length).toBe(1);
		expect(visibleWidth(compactLines[0]!)).toBeLessThanOrEqual(160);
		footer.dispose();
	});

	it("MessageDividerComponent omits blank padding rows in compact density", () => {
		const divider = new MessageDividerComponent({ label: () => "Model: claude", labelColor: "accent" });
		setChatTranscriptDisplayPreferences({ density: "comfortable" });
		expect(divider.render(60).length).toBe(3);

		setChatTranscriptDisplayPreferences({ density: "compact" });
		expect(divider.render(60).length).toBe(1);

		setChatTranscriptDisplayPreferences({ density: "comfortable" });
	});
});

describe("overlay-box split chrome alignment", () => {
	it("emits exact width columns across narrow widths including width <= sidebarWidth + 6", () => {
		const sidebarWidth = 14;
		for (const width of [0, 1, 2, 4, 6, 7, 10, 18, 20, 21, 22, 40]) {
			const top = topBorderSplit(width, "Title", sidebarWidth);
			const rowLine = splitRow("sidebar item", "body text", width, sidebarWidth);
			const div = dividerSplit(width, sidebarWidth);

			expect(visibleWidth(top)).toBe(width);
			expect(visibleWidth(rowLine)).toBe(width);
			expect(visibleWidth(div)).toBe(width);

			if (width >= 7) {
				const topPlain = Bun.stripANSI(top);
				const rowPlain = Bun.stripANSI(rowLine);
				const divPlain = Bun.stripANSI(div);
				const teeDownIdx = topPlain.indexOf(theme.boxRound.teeDown);
				const teeUpIdx = divPlain.indexOf(theme.boxRound.teeUp);
				expect(teeDownIdx).toBeGreaterThan(0);
				expect(teeUpIdx).toBe(teeDownIdx);
				expect(rowPlain[teeDownIdx]).toBe(theme.boxRound.vertical);
			}
		}
	});
});

describe("OAuthSelectorComponent titles", () => {
	const auth: OAuthSelectorAuthSource = {
		credentials: { has: () => false },
		keys: { source: () => undefined } as never,
	};

	it("uses two-word verb phrases 'log in' and 'log out'", () => {
		const login = new OAuthSelectorComponent(
			"login",
			auth,
			() => {},
			() => {},
		);
		const logout = new OAuthSelectorComponent(
			"logout",
			auth,
			() => {},
			() => {},
		);
		expect(login.title).toBe("Select provider to log in");
		expect(logout.title).toBe("Select provider to log out");
		login.stopValidation();
		logout.stopValidation();
	});
});

describe("astGrepToolRenderer padding and tab sanitization", () => {
	it("uses paddingX=1 across call, error, empty, and match views and expands tabs in match lines", () => {
		const callLines = astGrepToolRenderer
			.renderCall({ pat: "foo($X)" }, { expanded: false, isPartial: false }, theme)
			.render(80);
		expect(Bun.stripANSI(callLines[0]!)).toStartWith(" ");

		const errLines = astGrepToolRenderer
			.renderResult(
				{ content: [{ type: "text", text: "bad\tpattern" }], isError: true },
				{ expanded: false, isPartial: false },
				theme,
			)
			.render(80);
		expect(Bun.stripANSI(errLines[0]!)).toStartWith(" ");
		expect(errLines.join("\n")).not.toContain("\t");

		const emptyLines = astGrepToolRenderer
			.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: { matchCount: 0, fileCount: 0, filesSearched: 2, limitReached: false },
				},
				{ expanded: false, isPartial: false },
				theme,
			)
			.render(80);
		expect(Bun.stripANSI(emptyLines[0]!)).toStartWith(" ");

		const matchLines = astGrepToolRenderer
			.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						matchCount: 1,
						fileCount: 1,
						filesSearched: 1,
						limitReached: false,
						displayContent: ["# src/", "## a.ts", "*1│\tconst\tx = 1;"].join("\n"),
					},
				},
				{ expanded: true, isPartial: false },
				theme,
				{ pat: "const $X = 1" },
			)
			.render(80);
		for (const line of matchLines) {
			expect(line).not.toContain("\t");
			expect(Bun.stripANSI(line)).toStartWith(" ");
		}
	});
});

describe("narrow-terminal width guards", () => {
	it("keeps UsageDashboardComponent lines within width below 20 columns", () => {
		const component = new UsageDashboardComponent({
			reports: [
				{
					provider: "anthropic",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "anthropic:a:5h",
							label: "Claude 5 Hour",
							scope: { provider: "anthropic", accountId: "a", windowId: "5h" },
							window: { id: "5h", label: "5h" },
							amount: { usedFraction: 0.4, unit: "percent" },
							status: "ok",
						},
					],
				},
			],
			renderDetail: () => "detail",
			loadActivity: async push => push([]),
			requestRender: () => {},
			onClose: () => {},
		});
		try {
			for (const width of [6, 12, 18]) {
				for (const line of component.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		} finally {
			component.dispose();
		}
	});

	it("keeps web-search result lines within narrow widths below 24 columns", () => {
		const component = renderSearchResult(
			{
				content: [{ type: "text", text: "Answer body" }],
				details: {
					response: {
						provider: "perplexity",
						answer: "Answer body",
						sources: [
							{ title: "A very long article title", url: "https://sub.example.com/path", ageSeconds: 3600 },
						],
					},
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			{ query: "narrow query" },
		);
		for (const width of [10, 16, 22]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps BashInteractiveOverlayComponent lines within narrow widths below 20 columns", () => {
		class StubTerminal {
			modes = { applicationCursorKeysMode: false };
			buffer = { active: { viewportY: 0, length: 1, getLine: () => undefined, getNullCell: () => ({}) } };
			write(_data: string, cb?: () => void) {
				cb?.();
			}
			resize(_cols: number, _rows: number) {}
			dispose() {}
		}
		const component = new BashInteractiveOverlayComponent(
			"echo hello world",
			theme,
			() => 20,
			StubTerminal as never,
			{ resize: () => {} },
		);
		try {
			for (const width of [1, 2, 6, 12, 19]) {
				for (const line of component.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		} finally {
			component.dispose();
		}
	});
});
