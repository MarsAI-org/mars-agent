/**
 * Typed message contracts:
 * - the kind rides the peer bus as a bracketed prefix and round-trips
 * - the log records delivery status from the transport
 * - broadcast ("all") messages appear in both sides of a between() view
 */

import { describe, expect, test } from "bun:test";
import {
	formatBusBody,
	InMemoryMessageTransport,
	OrchestratorMessageLog,
	parseBusBody,
} from "../../src/orchestrator/message-bus";

describe("bus body encoding", () => {
	test("round-trips a typed message through the peer bus", () => {
		const body = formatBusBody("handoff", "interfaces are ready");
		expect(body).toBe("[handoff] interfaces are ready");
		expect(parseBusBody(body)).toEqual({ kind: "handoff", body: "interfaces are ready" });
	});

	test("a body without a prefix reads as plain coordination text", () => {
		expect(parseBusBody("just chatting")).toEqual({ kind: "coordination", body: "just chatting" });
	});

	test("an unknown bracket prefix stays plain text", () => {
		expect(parseBusBody("[nope] hi")).toEqual({ kind: "coordination", body: "[nope] hi" });
	});
});

describe("OrchestratorMessageLog", () => {
	test("records the delivery status from the transport", async () => {
		const log = new OrchestratorMessageLog();
		const transport = new InMemoryMessageTransport();
		const sent = await log.send({ from: "w1", to: "w2", kind: "status", body: "50% done" }, transport);
		expect(sent.status).toBe("delivered");
		expect(log.all()).toHaveLength(1);
	});

	test("records a failed delivery as failed", async () => {
		const log = new OrchestratorMessageLog();
		const transport = new InMemoryMessageTransport();
		transport.failingRecipients.add("w2");
		const sent = await log.send({ from: "w1", to: "w2", kind: "query", body: "schemas?" }, transport);
		expect(sent.status).toBe("failed");
	});

	test("between() shows direct traffic in both directions plus either side's broadcast", async () => {
		const log = new OrchestratorMessageLog();
		const transport = new InMemoryMessageTransport();
		await log.send({ from: "w1", to: "w2", kind: "query", body: "a" }, transport);
		await log.send({ from: "w2", to: "w1", kind: "reply", body: "b" }, transport);
		await log.send({ from: "w1", to: "all", kind: "status", body: "c" }, transport);
		await log.send({ from: "w2", to: "w3", kind: "status", body: "d" }, transport);
		expect(log.between("w1", "w2").map(message => message.body)).toEqual(["a", "b", "c"]);
	});
});
