/**
 * Typed inter-worker messages on top of the existing in-process message bus.
 *
 * The orchestrator's message schema (`from`, `to`, `kind`, `body`, `status`)
 * rides on the existing peer message bus (`IrcBus`) without changing that
 * bus's wire types: the kind is carried as a bracketed prefix on the body and
 * parsed back on receipt, so human-readable peer chat stays readable and the
 * typed record stays authoritative for the UI.
 *
 * Tests inject an in-memory transport instead of the global bus, so no test
 * depends on registry state.
 *
 * Design reference: ORCHESTRATOR_DESIGN.md sections 2.2 and 4.
 */

import { Snowflake } from "@marsai-org/utils";
import { IrcBus } from "../irc/bus";
import type { OrchestratorMessage, OrchestratorMessageKind } from "./types";

/** Body prefix that carries the typed kind across the bus. */
const KIND_PREFIX_PATTERN = /^\[(status|coordination|handoff|query|reply|alert)\]\s?/;

/** What a transport must provide for the orchestrator to deliver a message. */
export interface MessageTransport {
	send(message: OrchestratorMessage): Promise<{ delivered: boolean; error?: string }>;
}

/** In-memory transport for deterministic tests. */
export class InMemoryMessageTransport implements MessageTransport {
	readonly sent: OrchestratorMessage[] = [];
	/** Recipients that fail delivery, to exercise the failed path. */
	readonly failingRecipients = new Set<string>();
	/** Hook tests can await to observe a delivered message. */
	onDelivered: ((message: OrchestratorMessage) => void) | undefined;

	async send(message: OrchestratorMessage): Promise<{ delivered: boolean; error?: string }> {
		this.sent.push(message);
		if (this.failingRecipients.has(message.to)) {
			return { delivered: false, error: `recipient ${message.to} is unavailable` };
		}
		this.onDelivered?.(message);
		return { delivered: true };
	}
}

/** Transport backed by the process-global peer message bus. */
export class IrcMessageTransport implements MessageTransport {
	constructor(private readonly bus: IrcBus = IrcBus.global()) {}

	async send(message: OrchestratorMessage): Promise<{ delivered: boolean; error?: string }> {
		const receipt = await this.bus.send({
			from: message.from,
			to: message.to,
			body: formatBusBody(message.kind, message.body),
		});
		return { delivered: receipt.outcome !== "failed", error: receipt.error };
	}
}

/** Encode the kind on the body that crosses the peer bus. */
export function formatBusBody(kind: OrchestratorMessageKind, body: string): string {
	return `[${kind}] ${body}`;
}

/** Recover the kind from a bus body; unknown bodies are plain coordination text. */
export function parseBusBody(body: string): { kind: OrchestratorMessageKind; body: string } {
	const match = KIND_PREFIX_PATTERN.exec(body);
	if (!match) return { kind: "coordination", body };
	return { kind: match[1] as OrchestratorMessageKind, body: body.slice(match[0].length) };
}

/** Typed message log: the authoritative record the UI and replay artifacts read. */
export class OrchestratorMessageLog {
	readonly #messages: OrchestratorMessage[] = [];

	/** Record a message and deliver it; the stored record gets the real delivery status. */
	async send(
		message: Omit<OrchestratorMessage, "id" | "ts" | "status">,
		transport: MessageTransport,
	): Promise<OrchestratorMessage> {
		const pending: OrchestratorMessage = {
			...message,
			id: Snowflake.next(),
			ts: Date.now(),
			status: "sent",
		};
		this.#messages.push(pending);
		const receipt = await transport.send(pending);
		const settled: OrchestratorMessage = {
			...pending,
			status: receipt.delivered ? "delivered" : "failed",
		};
		this.#messages[this.#messages.indexOf(pending)] = settled;
		return settled;
	}

	all(): readonly OrchestratorMessage[] {
		return this.#messages;
	}

	/** Messages between two workers, in send order (either direction). */
	between(a: string, b: string): readonly OrchestratorMessage[] {
		return this.#messages.filter(message => {
			const direct = (message.from === a && message.to === b) || (message.from === b && message.to === a);
			const broadcast = message.to === "all" && (message.from === a || message.from === b);
			return direct || broadcast;
		});
	}
}
