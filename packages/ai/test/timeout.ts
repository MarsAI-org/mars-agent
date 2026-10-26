/**
 * Per-test wall clock that keeps a suite's original intent while scaling with
 * the runner.
 *
 * Bun's per-call timeout (`it(name, fn, ms)`) wins over the runner's
 * `--timeout`, so a literal silently replaces CI's `MARS_TEST_TIMEOUT` ceiling
 * with a tighter one, and these suites drive subprocesses and real HTTP
 * handlers. `scripts/ci-test-ts.ts` raises the ceiling to 120 s precisely
 * because a case that fits on a quiet machine crosses 30 s once eight chunks
 * compete for the runner.
 *
 * Raising every literal to the ceiling would also weaken the suite: a case
 * budgeted at 10 s would then hang for two minutes before reporting. Scale the
 * author's number instead, so a case that was tight stays proportionally tight
 * and only the shared budget moves.
 */
const runnerBudgetSeconds = Number.parseInt(Bun.env.MARS_TEST_TIMEOUT ?? "", 10);

/** Effective ceiling for one case: the runner's budget when stated, else 30 s. */
const ceilingMs = runnerBudgetSeconds > 0 ? runnerBudgetSeconds * 1000 : 30_000;

/**
 * Map an authored per-test budget into the runner's budget space.
 *
 * Cases already written at or above the runner's ceiling pass through: they
 * were deliberately generous and scaling them further buys nothing.
 */
export function scaledTimeout(authoredMs: number): number {
	if (authoredMs >= ceilingMs) return authoredMs;
	// Proportional share of the ceiling, floored at the author's own number so a
	// scaled budget never shrinks below what the case was measured against.
	return Math.max(authoredMs, Math.round((authoredMs / 30_000) * ceilingMs));
}
