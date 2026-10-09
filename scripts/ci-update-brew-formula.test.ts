import { describe, expect, it } from "bun:test";
import { renderFormula } from "./ci-update-brew-formula";

const SUMS = {
	"mars-darwin-arm64": "darwin_arm64_sha",
	"mars-darwin-x64": "darwin_x64_sha",
	"mars-linux-arm64": "linux_arm64_sha",
	"mars-linux-x64": "linux_x64_sha",
};

describe("renderFormula", () => {
	const formula = renderFormula("15.12.1", SUMS);

	// Regression: bare-binary URLs must opt out of Homebrew's UnpackStrategy.
	// Without `using: :nounzip` the default CurlDownloadStrategy nests the file
	// outside the staging CWD, `Dir["omp-*"].first` returns `nil`, and
	// `bin.install nil => "omp"` raises (issue #2398).
	it("attaches `using: :nounzip` to every per-platform url stanza", () => {
		const matches = formula.match(/using: :nounzip/g) ?? [];
		expect(matches).toHaveLength(4);
		for (const arch of ["mars-darwin-arm64", "mars-darwin-x64", "mars-linux-arm64", "mars-linux-x64"]) {
			expect(formula).toMatch(
				new RegExp(
					`url "https://github\\.com/[^"]+/${arch}",\\s+using: :nounzip\\s+sha256 "${SUMS[arch as keyof typeof SUMS]}"`,
				),
			);
		}
	});

	// Regression: completions generation must run with HOME redirected so the
	// popened binary doesn't touch the real `~/.mars` (denied by Homebrew's
	// sandbox profile) during the build (issue #2398).
	it("wraps `generate_completions_from_executable` with a HOME redirect to buildpath", () => {
		expect(formula).toMatch(
			/with_env\(HOME: buildpath\) do\n\s+generate_completions_from_executable\(bin\/"omp", "completions", shells: \[:bash, :zsh, :fish\]\)\n\s+end/,
		);
		// And the bare form (which is what failed in the sandbox) must not appear
		// outside the `with_env` block.
		const blockless = formula.replace(/with_env\(HOME: buildpath\) do[\s\S]*?end/, "");
		expect(blockless).not.toMatch(/generate_completions_from_executable/);
	});
});
