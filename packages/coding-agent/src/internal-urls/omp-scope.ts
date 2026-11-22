/**
 * Shared grammar for harness documentation URL scopes: which doc a URL names,
 * and the whole embedded corpus for the docs root (the handler's `enumerate`).
 *
 * `mars://` is canonical; `omp://` is accepted as a historical alias. Both
 * spellings share one grammar, and a root listing keeps the spelling it was
 * asked with so existing `omp://` links keep round-tripping.
 */
import * as path from "node:path";
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import type { InternalUrl, ResolveContext } from "./types";

/** Canonical harness documentation scheme. */
export const DOCS_SCHEME = "mars";
/** Historical harness documentation scheme, kept as an alias of {@link DOCS_SCHEME}. */
export const DOCS_SCHEME_ALIAS = "omp";

/** Scheme the caller spelled, so generated links keep it; `mars` for unknown/opaque input. */
export function docsScheme(url: InternalUrl): string {
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	return scheme === DOCS_SCHEME_ALIAS ? DOCS_SCHEME_ALIAS : DOCS_SCHEME;
}

/** Host + path of a docs URL, exactly as the handler reads it; `""` when the URL names the docs root. */
export function ompDocFilename(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;
	return host ? (pathname && pathname !== "/" ? host + pathname : host) : "";
}

/**
 * Canonical doc path relative to `docs/` for a docs URL, or `""` for the
 * docs root (`mars://`, `mars:///`, `mars://docs`, `mars://docs/`). Throws on
 * absolute paths and `..` traversal — the rejections the handler reports.
 */
export function ompDocRel(url: InternalUrl): string {
	const filename = ompDocFilename(url);
	if (filename.length === 0) return "";
	if (path.isAbsolute(filename)) throw new Error(`Absolute paths are not allowed in ${docsScheme(url)}:// URLs`);
	const normalized = path.posix.normalize(filename.replaceAll("\\", "/"));
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error(`Path traversal (..) is not allowed in ${docsScheme(url)}:// URLs`);
	}
	if (normalized === "." || normalized === "docs") return "";
	return normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
}

/** One embedded doc of a docs root scope. */
interface OmpDocEntry {
	/** Canonical `<scheme>://<rel>` URL, spelled with the caller's scheme. */
	url: string;
	/** Doc text. */
	content: string;
}

/**
 * Every embedded doc for a root scope, in docs-index (sorted) order. Empty
 * when no docs corpus is reachable. `scheme` selects the URL spelling
 * (`mars` unless the caller asked through the `omp` alias).
 */
export async function ompDocsScopeEntries(
	context?: ResolveContext,
	scheme: string = DOCS_SCHEME,
): Promise<OmpDocEntry[]> {
	const entries: OmpDocEntry[] = [];
	for (const rel of getDocFilenames()) {
		context?.signal?.throwIfAborted();
		const content = await getEmbeddedDoc(rel);
		if (content === undefined) continue;
		entries.push({ url: `${scheme}://${rel}`, content });
	}
	return entries;
}
