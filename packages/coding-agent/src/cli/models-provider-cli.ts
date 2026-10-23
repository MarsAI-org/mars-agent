/**
 * `mars models add-provider` / `remove-provider` — write a custom provider into
 * `models.yml`.
 *
 * The interactive path asks for the handful of values a working custom provider
 * needs (id, base URL, wire API, credential, model list) and writes the block.
 * Every value can also be passed as a flag, so the same code serves scripts,
 * where stdin is not a terminal.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { getBundledProviders } from "@marsai-org/catalog/models";
import { APP_NAME } from "@marsai-org/utils";
import chalk from "@marsai-org/utils/chalk";
import {
	defaultModelsConfigPath,
	findModelsConfigProblem,
	listProviderBlocks,
	readModelsConfigText,
	removeProviderBlock,
	upsertProviderBlock,
} from "../config/models-config-writer";
import { cfgProvidersContextWindows } from "../config/provider-context-window-settings";
import { type Settings, settings } from "../config/settings";
import { replaceFileAtomically } from "../utils/atomic-file";

/** Wires a `models.yml` provider block can name. Only chat transports are offered. */
export const CUSTOM_PROVIDER_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

/** Discovery modes offered for a provider whose `/models` endpoint lists its catalog. */
export const CUSTOM_PROVIDER_DISCOVERY = ["openai-models-list", "proxy", "litellm", "none"] as const;

export type CustomProviderDiscovery = (typeof CUSTOM_PROVIDER_DISCOVERY)[number];

export interface AddProviderOptions {
	/** Provider id written under `providers:`. Required. */
	id: string;
	/** Base URL, e.g. `https://gateway.example.com/v1`. Required. */
	baseUrl: string;
	/** Wire API every model inherits. Defaults to `openai-completions`. */
	api?: CustomProviderApi;
	/**
	 * Credential as written to `models.yml`: an environment variable name, a
	 * literal token, or a `!command`. Omit for a keyless endpoint.
	 */
	apiKey?: string;
	/** Model ids to declare. An empty list is valid only with discovery enabled. */
	models?: string[];
	/** How the provider advertises its catalog. Defaults to `none` (models are declared). */
	discovery?: CustomProviderDiscovery;
	/**
	 * Context window in tokens for the provider, for gateways whose own metadata
	 * states none or a smaller one. Stamped on every id in `models`; for a
	 * discovered catalog it goes to `providers.contextWindows` instead, since
	 * there are no ids at write time.
	 */
	maxContext?: number;
	/** Extra request headers, sent with every model of the provider. */
	headers?: Record<string, string>;
	/** Filesystem path of the models config to edit. Defaults to the agent's own. */
	path?: string;
	/** Replace an existing block for the same id instead of failing. */
	overwrite?: boolean;
	/** Validate the edited file and report it; does not write. */
	dryRun?: boolean;
	/**
	 * Settings store for the `providers.contextWindows` write of a discovered
	 * catalog. Defaults to the process-wide settings.
	 */
	settings?: Settings;
}

export interface AddProviderResult {
	path: string;
	/** Provider ids present after the edit. */
	providers: string[];
	/** Whether an existing block was replaced. */
	replaced: boolean;
	/** Edited document; only returned for `--dry-run`. */
	text?: string;
}

/** Build the `providers.<id>` mapping for the config file, omitting empty fields. */
export function buildProviderConfig(options: AddProviderOptions): Record<string, unknown> {
	const config: Record<string, unknown> = { baseUrl: options.baseUrl.trim() };
	const credential = options.apiKey?.trim();
	// No credential means the endpoint needs none: `auth: none` both satisfies the
	// loader's key requirement and marks the provider keyless, so discovery does
	// not wait on a sign-in.
	if (credential) config.apiKey = credential;
	else config.auth = "none";
	const api = options.api ?? "openai-completions";
	config.api = api;
	if (options.headers && Object.keys(options.headers).length > 0) config.headers = { ...options.headers };
	const discovery = options.discovery ?? "none";
	if (discovery !== "none") config.discovery = { type: discovery };
	const models = (options.models ?? []).map(id =>
		options.maxContext === undefined ? { id } : { id, contextWindow: options.maxContext },
	);
	if (models.length > 0) config.models = models;
	return config;
}

/** Why `options` cannot produce a loadable provider block, or `undefined`. */
export function validateAddProviderOptions(options: AddProviderOptions): string | undefined {
	const id = options.id?.trim();
	if (!id) return "Provider id is required.";
	if (/\s/.test(id)) return "Provider id must not contain whitespace.";
	const builtIn = getBundledProviders();
	if (builtIn.includes(id as (typeof builtIn)[number])) {
		// A built-in id here would shadow the catalog for every user of this file;
		// endpoints of built-in providers are changed with providers.endpoints or a
		// models.yml block that pins only baseUrl.
		return `"${id}" is a built-in provider. To change its endpoint, set a baseUrl override in models.yml or use providers.endpoints.`;
	}
	const baseUrl = options.baseUrl?.trim();
	if (!baseUrl) return "Base URL is required.";
	let protocol: string;
	try {
		protocol = new URL(baseUrl).protocol;
	} catch {
		return `Base URL must be an absolute URL, got "${baseUrl}".`;
	}
	if (protocol !== "http:" && protocol !== "https:") return `Base URL must use http or https, got "${protocol}".`;
	const discovery = options.discovery ?? "none";
	if ((options.models ?? []).length === 0 && discovery === "none") {
		return "Declare at least one model id, or enable discovery so the endpoint's model list is fetched.";
	}
	if (options.maxContext !== undefined) {
		if (!Number.isSafeInteger(options.maxContext)) {
			return `Context window must be a whole number of tokens, got "${options.maxContext}".`;
		}
		if (options.maxContext <= 0) return "Context window must be greater than zero.";
	}
	return undefined;
}

/** Replace the models config atomically, creating its directory when needed. */
async function writeModelsConfigAtomically(configPath: string, text: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
	const tempPath = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tempPath, text, { encoding: "utf-8", mode: 0o600 });
		await replaceFileAtomically(tempPath, configPath);
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => {});
	}
}

/**
 * Edit the models config: validate, write, and re-read through the real loader.
 *
 * The file is replaced atomically so an interrupted write can never leave a
 * half-written catalog behind. A document that fails validation is not written
 * at all, and the error names the provider the loader rejected.
 */
export async function addProvider(options: AddProviderOptions): Promise<AddProviderResult> {
	const problem = validateAddProviderOptions(options);
	if (problem) throw new Error(problem);

	const configPath = options.path ?? defaultModelsConfigPath();
	const current = readModelsConfigText(configPath);
	const id = options.id.trim();
	const existed = listProviderBlocks(current).includes(id);
	if (existed && !options.overwrite) {
		throw new Error(`Provider "${id}" already exists in ${configPath}. Pass --overwrite to replace it.`);
	}

	const text = upsertProviderBlock(current, id, buildProviderConfig(options));
	const discovered = (options.models ?? []).length === 0;
	const invalid = await findModelsConfigProblem(text, configPath);
	if (invalid) throw new Error(`Refusing to write an invalid ${path.basename(configPath)}: ${invalid}`);

	const providers = listProviderBlocks(text);
	if (options.dryRun) return { path: configPath, providers, replaced: existed, text };

	await writeModelsConfigAtomically(configPath, text);
	// A discovered catalog has no ids to attach the window to yet, so it goes
	// provider-wide and every row picked up at load inherits it.
	if (discovered && options.maxContext !== undefined) {
		const target = options.settings ?? settings;
		cfgProvidersContextWindows.set(target, { ...cfgProvidersContextWindows.get(target), [id]: options.maxContext });
		await target.flush();
	}
	return { path: configPath, providers, replaced: existed };
}

/** Remove a provider block. Reports whether one was there. */
export async function removeProvider(
	id: string,
	options: { path?: string; dryRun?: boolean } = {},
): Promise<{
	path: string;
	providers: string[];
	removed: boolean;
	text?: string;
}> {
	const configPath = options.path ?? defaultModelsConfigPath();
	const current = readModelsConfigText(configPath);
	const { text, removed } = removeProviderBlock(current, id);
	if (!removed) return { path: configPath, providers: listProviderBlocks(current), removed: false };

	const invalid = await findModelsConfigProblem(text, configPath);
	if (invalid) throw new Error(`Refusing to write an invalid ${path.basename(configPath)}: ${invalid}`);
	const providers = listProviderBlocks(text);
	if (options.dryRun) return { path: configPath, providers, removed, text };

	await writeModelsConfigAtomically(configPath, text);
	return { path: configPath, providers, removed };
}

/** Provider ids declared in `models.yml` right now. */
export function listCustomProviders(options: { path?: string } = {}): string[] {
	return listProviderBlocks(readModelsConfigText(options.path ?? defaultModelsConfigPath()));
}

function parseHeaderFlags(values: readonly string[] | undefined): Record<string, string> | undefined {
	if (!values || values.length === 0) return undefined;
	const headers: Record<string, string> = {};
	for (const entry of values) {
		const separator = entry.indexOf(":");
		if (separator <= 0) throw new Error(`Header must be "Name: value", got "${entry}".`);
		headers[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
	}
	return headers;
}

function splitList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const entries = value
		.split(",")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
	return entries.length > 0 ? entries : undefined;
}

/** Ask one question with a default; an empty answer keeps the default. */
async function ask(
	rl: readline.Interface,
	question: string,
	options: { defaultValue?: string; required?: boolean } = {},
): Promise<string> {
	for (;;) {
		const suffix = options.defaultValue ? chalk.dim(` [${options.defaultValue}]`) : "";
		const answer = (await rl.question(`  ${question}${suffix} `)).trim();
		if (answer.length > 0) return answer;
		if (options.defaultValue !== undefined) return options.defaultValue;
		if (!options.required) return "";
		process.stdout.write(chalk.yellow("  A value is required.\n"));
	}
}

/** Ask for an optional positive integer token window; a blank answer yields `undefined`. */
async function askWindow(rl: readline.Interface, question: string): Promise<number | undefined> {
	for (;;) {
		const answer = await ask(rl, question);
		if (answer.length === 0) return undefined;
		const window = Number(answer);
		if (Number.isSafeInteger(window) && window > 0) return window;
		process.stdout.write(chalk.yellow("  Enter a whole number of tokens, for example 200000.\n"));
	}
}

/** Interactive prompts for a provider block; used when required flags are missing. */
async function promptForProvider(seed: Partial<AddProviderOptions>): Promise<AddProviderOptions> {
	if (!process.stdin.isTTY) {
		// A pipe has no prompt loop to drive: answer-per-question would read the
		// next line as the wrong field and then block on EOF. Fail with the flags
		// a script should pass instead.
		throw new Error(
			"`mars models add-provider` needs a terminal for prompts. Pass --endpoint and a model list\n" +
				"  (`--models id1,id2`) or --discovery openai-models-list in non-interactive runs.",
		);
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write(`\n${chalk.bold("Add a custom provider")}\n`);
		process.stdout.write(chalk.dim(`Writes a providers.<id> block to models.yml. Ctrl+C cancels.\n\n`));
		const id = seed.id ?? (await ask(rl, "Provider id (e.g. acme):", { required: true }));
		const baseUrl =
			seed.baseUrl ?? (await ask(rl, "Base URL (e.g. https://gateway.example.com/v1):", { required: true }));
		const api = (seed.api ??
			(await ask(rl, `Wire API (${CUSTOM_PROVIDER_APIS.join(", ")}):`, {
				defaultValue: "openai-completions",
			}))) as CustomProviderApi;
		process.stdout.write(
			chalk.dim(
				"  Credential: an environment variable name (e.g. ACME_API_KEY), a literal token, or !command. Leave blank for none.\n",
			),
		);
		const credential = seed.apiKey ?? (await ask(rl, "Credential:"));
		const models =
			seed.models ??
			splitList(await ask(rl, "Model ids, comma separated (leave blank to discover them from the endpoint):"));
		const discovery = (seed.discovery ??
			(models === undefined
				? await ask(rl, `Discovery (${CUSTOM_PROVIDER_DISCOVERY.join(", ")}):`, {
						defaultValue: "openai-models-list",
					})
				: "none")) as CustomProviderDiscovery;
		process.stdout.write(
			chalk.dim(
				models === undefined
					? "  Context window: applies to every chat model discovered under this provider. Leave blank to use the provider's own.\n"
					: "  Context window: tokens every declared model accepts. Leave blank to use the provider's own.\n",
			),
		);
		const maxContext = seed.maxContext ?? (await askWindow(rl, "Context window in tokens:"));
		return {
			...seed,
			id,
			baseUrl,
			api,
			apiKey: credential && credential.length > 0 ? credential : undefined,
			models,
			discovery,
			maxContext,
		};
	} finally {
		rl.close();
	}
}

export interface AddProviderCommandArgs {
	/** Provider id; omitted starts the interactive flow. */
	id?: string;
	flags: {
		baseUrl?: string;
		api?: string;
		/** Credential as written to models.yml (env var name, token, or `!command`). */
		token?: string;
		models?: string;
		discovery?: string;
		/** Context window in tokens for every declared model. */
		maxContext?: number;
		header?: string[];
		path?: string;
		overwrite?: boolean;
		dryRun?: boolean;
		json?: boolean;
	};
}

function describe(result: AddProviderResult | { path: string; providers: string[]; removed: boolean }): void {
	const lines = [
		`${chalk.dim("config")} ${result.path}`,
		`${chalk.dim("providers")} ${result.providers.length > 0 ? result.providers.join(", ") : "(none)"}`,
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}

/** Entry point behind `mars models add-provider`. */
export async function runAddProviderCommand(args: AddProviderCommandArgs): Promise<void> {
	const { flags } = args;
	let options: AddProviderOptions;
	try {
		const headers = parseHeaderFlags(flags.header);
		// Only flags the caller passed seed a prompt: an empty string would read as
		// an answer and skip the question.
		const seed: Partial<AddProviderOptions> = {
			...(flags.baseUrl === undefined ? {} : { baseUrl: flags.baseUrl }),
			...(flags.api === undefined ? {} : { api: flags.api as CustomProviderApi }),
			apiKey: flags.token,
			models: splitList(flags.models),
			discovery: flags.discovery as CustomProviderDiscovery | undefined,
			headers,
			maxContext: flags.maxContext,
		};
		options = args.id === undefined ? await promptForProvider(seed) : { id: args.id, baseUrl: "", ...seed };
		options.path = flags.path;
		options.overwrite = flags.overwrite;
		options.dryRun = flags.dryRun;

		const result = await addProvider(options);
		if (flags.json) {
			process.stdout.write(
				`${JSON.stringify({ path: result.path, providers: result.providers, replaced: result.replaced, text: result.text }, null, 2)}\n`,
			);
			return;
		}
		if (flags.dryRun) {
			process.stdout.write(chalk.dim(`# dry run — ${result.path} not written\n`));
			process.stdout.write(`${result.text ?? ""}`);
			return;
		}
		process.stdout.write(
			chalk.green(`${result.replaced ? "Updated" : "Added"} provider "${options.id}" in ${result.path}\n`),
		);
		describe(result);
		const modelIds = options.models ?? [];
		if (options.maxContext !== undefined && modelIds.length === 0) {
			process.stdout.write(
				`${chalk.dim("window")} ${options.maxContext} tokens via providers.contextWindows.${options.id}\n`,
			);
		}
		const hint =
			modelIds.length > 0
				? `${APP_NAME} models ${options.id}`
				: `${APP_NAME} models refresh  ${chalk.dim("# fetch the endpoint's model list")}`;
		process.stdout.write(chalk.dim(`\nNext: ${hint}\n`));
	} catch (error) {
		process.stderr.write(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`));
		process.exitCode = 1;
	}
}

/** Entry point behind `mars models remove-provider`. */
export async function runRemoveProviderCommand(
	id: string,
	flags: { path?: string; dryRun?: boolean; json?: boolean },
): Promise<void> {
	try {
		const result = await removeProvider(id, { path: flags.path, dryRun: flags.dryRun });
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		if (!result.removed) {
			process.stderr.write(chalk.yellow(`No provider "${id}" in ${result.path}\n`));
			process.exitCode = 1;
			return;
		}
		if (flags.dryRun) {
			process.stdout.write(chalk.dim(`# dry run — ${result.path} not written\n${result.text ?? ""}`));
			return;
		}
		process.stdout.write(chalk.green(`Removed provider "${id}" from ${result.path}\n`));
		describe(result);
	} catch (error) {
		process.stderr.write(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`));
		process.exitCode = 1;
	}
}

/** Entry point behind `mars models providers` (list the custom blocks). */
export function runListProvidersCommand(flags: { path?: string; json?: boolean }): void {
	const configPath = flags.path ?? defaultModelsConfigPath();
	const providers = listCustomProviders({ path: configPath });
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ path: configPath, providers }, null, 2)}\n`);
		return;
	}
	if (providers.length === 0) {
		process.stdout.write(`${chalk.dim(`No custom providers in ${configPath}.`)}\n`);
		process.stdout.write(
			chalk.dim(`Add one with \`${APP_NAME} models add-provider\`, or set providers.endpoints for a built-in.\n`),
		);
		return;
	}
	process.stdout.write(`${chalk.bold(configPath)}\n`);
	for (const provider of providers) process.stdout.write(`  ${provider}\n`);
}
