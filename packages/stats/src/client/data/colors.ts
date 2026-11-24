/**
 * Categorical series colors. Every multi-series chart and table swatch draws
 * from {@link SERIES_COLORS}; ranking keeps the busiest series on the most
 * legible hues and the same key on the same hue across charts of one page.
 */

/** Ten mid-luminance hues that clear 3:1 contrast on both Mars Obsidian and Mars Alabaster. */
export const SERIES_COLORS = [
	"#d64a27", // mars terracotta
	"#2c7a7b", // deep teal
	"#c77d1e", // warm ochre
	"#4e79a7", // slate blue
	"#3b9c6e", // sage green
	"#8e5ea2", // muted plum
	"#e6734c", // ember coral
	"#5b8c85", // mineral jade
	"#b85c6b", // terracotta rose
	"#9e8238", // desert brass
];

/** Neutral used for "Other" rollups and unknown buckets. */
export const OTHER_COLOR = "#6b625c";

/** Stable identity of a model across providers: `model::provider`. */
export function modelKey(model: string, provider: string): string {
	return `${model}::${provider}`;
}

/**
 * Assign colors by descending weight (ties broken by key) so a model's hue is
 * determined by its rank, not by response order. Used by every per-model view.
 */
export function buildModelColorLookup(
	records: readonly { model: string; provider: string; totalRequests: number }[],
): Map<string, string> {
	return buildColorLookup(
		records.map(record => ({ key: modelKey(record.model, record.provider), weight: record.totalRequests })),
	);
}

/** Generic form of {@link buildModelColorLookup} for any keyed, weighted series. */
export function buildColorLookup(items: readonly { key: string; weight: number }[]): Map<string, string> {
	const ranked = [...items].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
	return new Map(ranked.map((item, index) => [item.key, SERIES_COLORS[index % SERIES_COLORS.length]]));
}
