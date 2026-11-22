/**
 * Read and edit `models.yml` without rewriting the user's file.
 *
 * The registry only ever reads this file, so nothing else owns its formatting.
 * A full parse-and-reserialize would drop comments and reorder keys, which is a
 * poor trade for adding one provider block. This module instead splices a single
 * `providers.<id>` block into the existing text and leaves every other byte —
 * comments, quoting, ordering — untouched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent, stringifyYamlConfig } from "@marsai-org/utils";
import { YAML } from "bun";
import { ModelsConfigFile } from "./models-config";

/** Default file the CLI writes: the same path the registry reads. */
export function defaultModelsConfigPath(): string {
	return path.join(getAgentDir(), "models.yml");
}

/** Current text of the models config, or `""` when the file does not exist yet. */
export function readModelsConfigText(configPath: string): string {
	try {
		return fs.readFileSync(configPath, "utf-8");
	} catch (error) {
		if (isEnoent(error)) return "";
		throw error;
	}
}

const PROVIDERS_ROOT = /^providers\s*:\s*(.*)$/;
const EMPTY_INLINE_MAP = /^\s*\{\s*\}\s*$/;
const COMMENT_OR_BLANK = /^\s*(#.*)?$/;

/** Indentation width of a line, or -1 for a line with no content to measure. */
function indentOf(line: string): number {
	const match = /^ */.exec(line);
	return match ? match[0].length : 0;
}

function isCommentOrBlank(line: string): boolean {
	return COMMENT_OR_BLANK.test(line);
}

/**
 * Render one provider block at `indent`, with the provider key and its nested
 * body. Values are serialized through the same YAML writer `config.yml` uses so
 * multi-line strings and nested maps stay readable.
 */
function renderProviderBlock(providerId: string, config: Record<string, unknown>, indent: number): string[] {
	const pad = " ".repeat(indent);
	const body = stringifyYamlConfig({ [providerId]: config }).replace(/\n$/, "");
	return body.split("\n").map(line => `${pad}${line}`);
}

/** Index just past the root `providers:` section, or -1 when the file has none. */
function findProvidersSection(lines: string[]): { header: number; end: number } | -1 {
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (indentOf(line) !== 0) continue;
		const match = PROVIDERS_ROOT.exec(line);
		if (!match) continue;
		let end = index + 1;
		while (end < lines.length) {
			const next = lines[end]!;
			if (!isCommentOrBlank(next) && indentOf(next) === 0) break;
			end++;
		}
		return { header: index, end };
	}
	return -1;
}

/** First non-blank, non-comment line inside the section, to learn the child indent. */
function sectionIndent(lines: string[], section: { header: number; end: number }): number {
	for (let index = section.header + 1; index < section.end; index++) {
		const line = lines[index]!;
		if (isCommentOrBlank(line)) continue;
		return indentOf(line);
	}
	return 2;
}

/** Locate `providers.<id>` and the last line belonging to its block. */
function findProviderBlock(
	lines: string[],
	section: { header: number; end: number },
	childIndent: number,
	providerId: string,
): { start: number; end: number } | undefined {
	for (let index = section.header + 1; index < section.end; index++) {
		const line = lines[index]!;
		if (isCommentOrBlank(line) || indentOf(line) !== childIndent) continue;
		const parsed = /^\s+(?:"([^"]+)"|'([^']+)'|([^:#]+?))\s*:/.exec(line);
		const key = parsed?.[1] ?? parsed?.[2] ?? parsed?.[3];
		if (key?.trim() !== providerId) continue;
		let end = index + 1;
		while (end < section.end) {
			const next = lines[end]!;
			if (!isCommentOrBlank(next) && indentOf(next) <= childIndent) break;
			end++;
		}
		// Trailing blank lines belong to the separator, not the block.
		while (end > index + 1 && isCommentOrBlank(lines[end - 1]!)) end--;
		return { start: index, end };
	}
	return undefined;
}

/**
 * Rewrite an inline `providers: {…}` header as a block mapping.
 *
 * Appending a block child under a flow-mapping header produces invalid YAML, so
 * the entries already inside the flow map are expanded first. Returns the new
 * document text, or `undefined` when the header needs no expansion.
 */
function expandInlineProviders(text: string, lines: string[], section: { header: number }): string | undefined {
	const headerLine = lines[section.header]!;
	const inline = (PROVIDERS_ROOT.exec(headerLine)?.[1] ?? "").trim();
	if (inline.length === 0 || inline.startsWith("#")) return undefined;

	let parsed: unknown;
	try {
		parsed = YAML.parse(headerLine);
	} catch {
		// A multi-line flow mapping does not parse from its header alone; leave the
		// text as it is and let the post-edit validation refuse an invalid result.
		return undefined;
	}
	const providers =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>).providers
			: undefined;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;

	const expanded: string[] = ["providers:"];
	for (const [id, config] of Object.entries(providers as Record<string, unknown>)) {
		if (!config || typeof config !== "object" || Array.isArray(config)) {
			// Expanding would drop this entry, which is worse than refusing the edit:
			// the caller keeps its file and sees why.
			throw new Error(`providers.${id} in the inline map is not a mapping; rewrite the file as block YAML first.`);
		}
		expanded.push(...renderProviderBlock(id, config as Record<string, unknown>, 2));
	}
	lines.splice(section.header, 1, ...expanded);
	return `${lines.join("\n")}\n`;
}

/**
 * Insert or replace one `providers.<id>` block.
 *
 * New providers are appended inside the `providers:` section (created when the
 * file lacks one). An existing block for the same id is replaced in place so
 * re-running the CLI is idempotent.
 */
export function upsertProviderBlock(text: string, providerId: string, config: Record<string, unknown>): string {
	const lines = text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
	// A trailing newline produces one empty final element; keep it out of the edit.
	const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	if (trailingNewline) lines.pop();

	const section = findProvidersSection(lines);
	if (section === -1) {
		const block = renderProviderBlock(providerId, config, 2);
		const prefix = lines.length === 0 || lines[lines.length - 1]!.trim() === "" ? [] : [""];
		const result = [...lines, ...prefix, "providers:", ...block];
		return `${result.join("\n")}\n`;
	}

	// A flow mapping cannot take block children; expand it and redo the edit.
	const expanded = expandInlineProviders(text, lines, section);
	if (expanded !== undefined) return upsertProviderBlock(expanded, providerId, config);

	const headerLine = lines[section.header]!;
	if (EMPTY_INLINE_MAP.test(PROVIDERS_ROOT.exec(headerLine)![1] ?? "")) {
		lines[section.header] = "providers:";
	}

	const childIndent = sectionIndent(lines, section);
	const existing = findProviderBlock(lines, section, childIndent, providerId);
	const block = renderProviderBlock(providerId, config, childIndent);

	if (existing) {
		lines.splice(existing.start, existing.end - existing.start, ...block);
	} else {
		// Insert before the blank separator that closes the section.
		let insertAt = section.end;
		while (insertAt > section.header + 1 && isCommentOrBlank(lines[insertAt - 1]!)) insertAt--;
		lines.splice(insertAt, 0, ...block);
	}
	return `${lines.join("\n")}\n`;
}

/** Remove one `providers.<id>` block; reports whether anything changed. */
export function removeProviderBlock(text: string, providerId: string): { text: string; removed: boolean } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	if (trailingNewline) lines.pop();
	const section = findProvidersSection(lines);
	if (section === -1) return { text, removed: false };
	const existing = findProviderBlock(lines, section, sectionIndent(lines, section), providerId);
	if (!existing) return { text, removed: false };
	lines.splice(existing.start, existing.end - existing.start);

	// An emptied section would parse as `providers: null`, which the schema rejects.
	// Collapse the whole section to an explicit empty mapping; comments inside it
	// described the blocks that are now gone, so they go with it.
	const remaining = lines.slice(section.header + 1, section.end - (existing.end - existing.start));
	if (remaining.every(isCommentOrBlank)) {
		lines.splice(section.header, section.end - section.header, "providers: {}");
	}
	return { text: `${lines.join("\n")}\n`, removed: true };
}

/** Provider ids declared under `providers:` in the file text. */
export function listProviderBlocks(text: string): string[] {
	if (text.trim().length === 0) return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const section = findProvidersSection(lines);
	if (section === -1) return [];
	const childIndent = sectionIndent(lines, section);
	const ids: string[] = [];
	for (let index = section.header + 1; index < section.end; index++) {
		const line = lines[index]!;
		if (isCommentOrBlank(line) || indentOf(line) !== childIndent) continue;
		const parsed = /^\s+(?:"([^"]+)"|'([^']+)'|([^:#]+?))\s*:/.exec(line);
		const key = parsed?.[1] ?? parsed?.[2] ?? parsed?.[3];
		if (key) ids.push(key.trim());
	}
	return ids;
}

/**
 * Why the edited document would not load, or `undefined` when it validates.
 *
 * `targetPath` is the file the text is destined for; the scratch copy is written
 * beside it so the loader's directory-derived behavior matches the real file.
 */
export async function findModelsConfigProblem(
	text: string,
	targetPath = defaultModelsConfigPath(),
): Promise<string | undefined> {
	// Validate through the real loader at a scratch path: that runs the schema and
	// the provider rules (baseUrl requirements, api/kind agreement) exactly as the
	// registry will at startup.
	const directory = path.dirname(targetPath);
	const scratch = path.join(directory, `.models-${process.pid}-${Math.random().toString(36).slice(2)}.yml`);
	try {
		await fs.promises.mkdir(directory, { recursive: true });
		await fs.promises.writeFile(scratch, text, { encoding: "utf-8", mode: 0o600 });
		const result = ModelsConfigFile.relocate(scratch).tryLoad();
		if (result.status === "ok") return undefined;
		if (result.status === "error") return result.error.message;
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		await fs.promises.rm(scratch, { force: true }).catch(() => {});
	}
}
