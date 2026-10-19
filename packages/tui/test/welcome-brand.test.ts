import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MARS_LOGO, WelcomeComponent } from "@marsai-org/tui/prompt/welcome";
import { getThemeByName, initTheme } from "@marsai-org/tui/theme";
import { SYMBOL_PRESETS } from "@marsai-org/tui/theme/symbols";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@marsai-org/utils";

/** Expand half-block rows into a boolean pixel grid (top pixel row first). */
function pixels(rows: readonly string[]): boolean[][] {
	const grid: boolean[][] = [];
	for (const row of rows) {
		const top: boolean[] = [];
		const bottom: boolean[] = [];
		for (const char of row) {
			top.push(char === "▀" || char === "█");
			bottom.push(char === "▄" || char === "█");
		}
		grid.push(top, bottom);
	}
	return grid;
}

/** Glyph cells of a wordmark row, split at the fixed 3-column letters + 1-column gaps. */
function glyphCells(grid: boolean[][]): boolean[][][] {
	return [0, 4, 8, 12].map(start => grid.map(row => row.slice(start, start + 3)));
}

function render(chars: string[]): string {
	return chars.map((char, index) => `${char}${index === chars.length - 1 ? "" : " "}`).join("");
}

describe("welcome brand artwork", () => {
	it("spells `mars` in the wordmark, not the upstream `omp`", async () => {
		await initTheme(false);
		const rows = new WelcomeComponent("1.0.0").render(80).map(row => Bun.stripANSI(row));
		const first = rows.findIndex(row => row.includes("█▄█"));
		expect(first).toBeGreaterThanOrEqual(0);
		const start = rows[first]!.indexOf("█▄█");
		const wordmark = rows.slice(first, first + 3).map(row => row.slice(start, start + 15).padEnd(15, " "));

		// Rebuild the four glyph cells from the rendered rows and read them back.
		const cells = glyphCells(pixels(wordmark));
		expect(cells).toHaveLength(4);
		expect(cells.map(cell => render(cell.map(row => row.map(on => (on ? "#" : ".")).join(""))))).toEqual([
			render(["#.#", "###", "#.#", "#.#", "#.#", "..."]),
			render([".#.", "#.#", "###", "#.#", "#.#", "..."]),
			render(["##.", "#.#", "#..", "#..", "#..", "..."]),
			render([".##", "#..", ".#.", "..#", "##.", "..."]),
		]);

		// Neither the old wordmark nor the old Pi mark may survive anywhere.
		const frame = rows.join("\n");
		expect(frame).not.toContain("▄▀▀▄ █▀▄▀▄ █▀▀▄");
		expect(frame).not.toContain("████████████");
	});

	it("draws the Mars mark from the logo asset's silhouette", async () => {
		await initTheme(false);
		expect(MARS_LOGO).toEqual(["▄███    ███▄", "███▀████▀███", "███ ▀██▀ ███", "███      ███", "███▀▀▀▀▀▀███"]);
		expect(new WelcomeComponent("1.0.0").render(32).map(row => Bun.stripANSI(row)).join("\n")).toContain(
			MARS_LOGO[0]!,
		);
	});

	it("keeps `icon.omp` as a working alias of `icon.mars`", () => {
		for (const preset of ["unicode", "nerd", "ascii"] as const) {
			expect(SYMBOL_PRESETS[preset]["icon.mars"]).toBeDefined();
			expect(SYMBOL_PRESETS[preset]["icon.omp"]).toBe(SYMBOL_PRESETS[preset]["icon.mars"]);
		}
		expect(SYMBOL_PRESETS.unicode["icon.mars"]).not.toBe("π");
		expect(SYMBOL_PRESETS.ascii["icon.mars"]).toBe("mars");
	});

	it("applies a legacy `icon.omp` theme override to `icon.mars`", async () => {
		const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mars-brand-alias-"));
		const originalAgentDir = getAgentDir();
		try {
			setAgentDir(temp);
			const dark = await Bun.file(path.join(import.meta.dir, "..", "src", "theme", "dark.json")).json();
			await Bun.write(
				path.join(getCustomThemesDir(), "legacy-brand.json"),
				JSON.stringify({ ...dark, name: "legacy-brand", symbols: { overrides: { "icon.omp": "LEGACY" } } }),
			);
			const legacy = await getThemeByName("legacy-brand");
			expect(legacy?.icon.mars).toBe("LEGACY");
			expect(legacy?.icon.omp).toBe("LEGACY");
		} finally {
			setAgentDir(originalAgentDir);
			await removeWithRetries(temp);
		}
	});
});
