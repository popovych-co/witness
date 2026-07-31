import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const wf = (name: string) =>
	parse(
		readFileSync(join(__dirname, "..", ".github", "workflows", name), "utf8"),
	);
const raw = (name: string) =>
	readFileSync(join(__dirname, "..", ".github", "workflows", name), "utf8");

describe("workflow tiers", () => {
	it("ci runs per commit, model-free — no API key, no calibrate", () => {
		const y = wf("ci.yml");
		expect(Object.keys(y.on)).toEqual(
			expect.arrayContaining(["push", "pull_request"]),
		);
		expect(raw("ci.yml")).not.toContain("ANTHROPIC_API_KEY");
		expect(raw("ci.yml")).not.toContain("calibrate");
	});

	it("calibration runs nightly, on dispatch with a model input, and on prompt/fixture changes", () => {
		const y = wf("calibration.yml");
		expect(y.on.schedule[0].cron).toBeDefined();
		expect(y.on.workflow_dispatch.inputs.model).toBeDefined();
		expect(y.on.pull_request.paths).toEqual(
			expect.arrayContaining(["prompts/**", "calibration/**"]),
		);
		expect(raw("calibration.yml")).toContain("ANTHROPIC_API_KEY");
		expect(raw("calibration.yml")).not.toContain("--publish");
	});

	it("release requires tests, version sync, and the release gate", () => {
		const r = raw("release.yml");
		expect(wf("release.yml").on.push.tags).toBeDefined();
		expect(r).toContain("sync-versions");
		expect(r).toContain("scripts/release-gate.mjs");
		expect(r).toContain("npm publish");
	});

	// The lockfile is pnpm's; an `npm ci` step fails outright on the missing
	// package-lock.json — every tier installs from the committed pnpm lock.
	it("every workflow installs from the frozen pnpm lockfile", () => {
		for (const name of ["ci.yml", "calibration.yml", "release.yml"]) {
			const r = raw(name);
			expect(r, name).toContain("pnpm/action-setup");
			expect(r, name).toContain("pnpm install --frozen-lockfile");
			expect(r, name).not.toMatch(/\bnpm ci\b/);
			expect(r, name).not.toContain("package-lock.json");
		}
	});

	// pnpm's own publish has lost the npm OIDC/auth path more than once
	// (pnpm/pnpm#11513, #11566) — the release publishes with the npm CLI.
	it("release publishes with the npm CLI, not pnpm publish", () => {
		const r = raw("release.yml");
		expect(r).toMatch(/^\s+- run: npm publish --provenance$/m);
		expect(r).not.toContain("pnpm publish");
	});

	it("release publishes with provenance and holds the OIDC permission", () => {
		const y = wf("release.yml");
		expect(y.permissions["id-token"]).toBe("write");
		expect(raw("release.yml")).toContain("--provenance");
	});

	it("release is model-free — no API key on the publish path", () => {
		expect(raw("release.yml")).not.toContain("ANTHROPIC_API_KEY");
	});
});
