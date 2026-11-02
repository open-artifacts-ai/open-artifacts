// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// prod-inspect.yml: prod's platform D1 schema, read-only, by hand only, from
// main, in the prod Environment, with main's scripts only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root } from "./stubs.ts";

const text = readFileSync(
  join(root, ".github/workflows/prod-inspect.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
const job = w.jobs.inspect;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const steps: Record<string, any>[] = job.steps;

describe("prod-inspect.yml", () => {
  it("runs only on dispatch with no inputs, read-only, one at a time, in prod's Environment", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(w.on.workflow_dispatch?.inputs).toBeUndefined();
    expect(w.permissions).toEqual({ contents: "read" });
    expect(Object.keys(w.jobs)).toEqual(["inspect"]);
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBe("hosted-prod-deploy");
    expect(w.concurrency).toEqual({
      group: "prod-inspect",
      "cancel-in-progress": false,
    });
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(10);
  });

  it("refuses any ref but main first", () => {
    expect(steps[0]).toMatchObject({
      name: "On main",
      env: { REF: "${{ github.ref }}" },
    });
    expect(steps[0]?.run).toContain('[ "$REF" = refs/heads/main ] ||');
    expect(steps[0]?.run).toContain("exit 1");
  });

  it("checks out main's scripts/ci and .github/hosted only, SHA-pinned, no credentials", () => {
    for (const l of text.split("\n").filter((l) => /^\s*- uses: /.test(l)))
      expect(l).toMatch(/@[0-9a-f]{40} # v\d/);
    const outs = steps.filter((s) => s.uses);
    expect(outs).toHaveLength(1);
    expect(outs[0]?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(outs[0]?.with).toEqual({
      ref: "${{ github.sha }}",
      "sparse-checkout": "scripts/ci\n.github/hosted\n",
      "persist-credentials": false,
    });
  });

  it("loads the account id, then runs the script; only it sees the token", () => {
    expect(steps.slice(2).map((s) => [s.name, s.run])).toEqual([
      [
        "Load the hosted constants",
        "bash scripts/ci/hosted-constants.sh prod .github/hosted > /dev/null",
      ],
      ["Read the schema", "bash scripts/ci/prod-inspect.sh"],
    ]);
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets.map((s) => s.name)).toEqual(["Read the schema"]);
    expect(withSecrets[0]?.env).toEqual({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
    expect(text).not.toContain("vars.");
    expect(text).not.toContain("inputs.");
  });
});
