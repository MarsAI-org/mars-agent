import { afterEach, describe, expect, it } from "bun:test";
import {
	disableProvider,
	enableProvider,
	isProviderEnabled,
	resetCapabilityForTests,
} from "@marsai-org/coding-agent/capability";

// `mars-plugins` is the canonical discovery provider id. Persisted user config
// written before the rebrand still names `omp-plugins`, so both spellings must
// drive the same switch.
describe("mars-plugins provider id aliases", () => {
	afterEach(() => {
		resetCapabilityForTests();
	});

	it("is enabled by default under both names", () => {
		expect(isProviderEnabled("mars-plugins")).toBe(true);
		expect(isProviderEnabled("omp-plugins")).toBe(true);
	});

	it("disabling the canonical id also disables the legacy id", () => {
		disableProvider("mars-plugins");
		expect(isProviderEnabled("mars-plugins")).toBe(false);
		expect(isProviderEnabled("omp-plugins")).toBe(false);
	});

	it("disabling the legacy id also disables the canonical id", () => {
		disableProvider("omp-plugins");
		expect(isProviderEnabled("mars-plugins")).toBe(false);
		expect(isProviderEnabled("omp-plugins")).toBe(false);
	});

	it("enabling the canonical id clears a legacy disable", () => {
		disableProvider("omp-plugins");
		enableProvider("mars-plugins");
		expect(isProviderEnabled("mars-plugins")).toBe(true);
		expect(isProviderEnabled("omp-plugins")).toBe(true);
	});
});
