// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// hosted-publish.yml (design v7 6.4): releases reach each env's bucket after
// release-please on main, staging first, behind the release gate, with the R2
// key derived from the Environment's one token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root } from "./stubs.ts";

const text = readFileSync(
  join(root, ".github/workflows/hosted-publish.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
type Step = Record<string, any>;
const steps = (job: string): Step[] => w.jobs[job].steps;
const named = (job: string, n: string) =>
  steps(job).find((s) => s.name === n) as Step;
const ENVS = { "publish-staging": "staging", "publish-prod": "prod" } as const;

describe("hosted-publish.yml", () => {
  it("runs after release-please on main, or by hand with tag, env and floor_run_id", () => {
    expect(w.on.workflow_run).toEqual({
      workflows: ["release-please"],
      types: ["completed"],
      branches: ["main"],
    });
    expect(Object.keys(w.on.workflow_dispatch.inputs).sort()).toEqual([
      "env",
      "floor_run_id",
      "tag",
    ]);
    expect(w.on.workflow_dispatch.inputs.env.options).toEqual([
      "both",
      "staging",
      "prod",
    ]);
    expect(w.on.workflow_dispatch.inputs.env.default).toBe("both");
    expect(Object.keys(w.on).sort()).toEqual([
      "workflow_dispatch",
      "workflow_run",
    ]);
    expect(w.permissions).toEqual({});
  });

  it("resolve reads only, from main, through the tested script", () => {
    const j = w.jobs.resolve;
    expect(j.permissions).toEqual({ contents: "read", actions: "read" });
    expect(j.environment).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain("secrets.");
    expect(named("resolve", "Runs only from main").run).toBe(
      'test "$REF" = refs/heads/main',
    );
    const what = named("resolve", "What to publish");
    expect(what.run).toBe("bash scripts/ci/hosted-publish-resolve.sh");
    expect(what.env.HEAD_SHA).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(what.env.CONCLUSION).toBe(
      "${{ github.event.workflow_run.conclusion }}",
    );
    expect(Object.keys(j.outputs).sort()).toEqual([
      "floor_run_id",
      "kind",
      "prod",
      "staging",
      "tag",
    ]);
  });

  it("the staging job is named for its kind and tag: the record a prod-only dispatch looks for", () => {
    expect(w.jobs["publish-staging"].name).toBe(
      "publish-staging ${{ needs.resolve.outputs.kind }} ${{ needs.resolve.outputs.tag }}",
    );
    const resolveSh = readFileSync(
      join(root, "scripts/ci/hosted-publish-resolve.sh"),
      "utf8",
    );
    expect(resolveSh).toContain('"publish-staging release $1"');
  });
  it("staging first: prod needs a green staging publish unless only prod was asked for", () => {
    expect(w.jobs["publish-staging"].needs).toBe("resolve");
    expect(w.jobs["publish-staging"].if).toBe(
      "${{ needs.resolve.outputs.staging == 'true' }}",
    );
    expect(w.jobs["publish-prod"].needs).toEqual([
      "resolve",
      "publish-staging",
    ]);
    const cond = w.jobs["publish-prod"].if as string;
    const runs = (staging: string, prod: string, result: string) =>
      new Function(
        "needs",
        `return (${cond
          .replace(/^\$\{\{\s*/, "")
          .replace(/\s*\}\}$/, "")
          .replace("!cancelled()", "true")
          .replaceAll("needs.publish-staging", 'needs["publish-staging"]')});`,
      )({
        resolve: { outputs: { staging, prod } },
        "publish-staging": { result },
      }) as boolean;
    expect(runs("true", "true", "success")).toBe(true);
    expect(runs("true", "true", "failure")).toBe(false);
    expect(runs("true", "true", "skipped")).toBe(false);
    expect(runs("false", "true", "skipped")).toBe(true);
    expect(runs("true", "false", "success")).toBe(false);
  });

  for (const [job, env] of Object.entries(ENVS)) {
    describe(job, () => {
      it("runs in the env's deploy Environment, main only, one at a time, actions pinned", () => {
        const j = w.jobs[job];
        expect(j.environment).toBe(`hosted-${env}-deploy`);
        expect(j.permissions).toEqual({ contents: "read", actions: "read" });
        expect(j.concurrency).toEqual({
          group: `hosted-publish-${env}`,
          "cancel-in-progress": false,
        });
        expect(steps(job)[0]?.run).toBe('test "$REF" = refs/heads/main');
        for (const s of steps(job).filter((s) => s.uses)) {
          expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
          if (String(s.uses).startsWith("actions/checkout@"))
            expect(s.with).toEqual({
              ref: "${{ github.sha }}",
              "persist-credentials": false,
            });
        }
      });

      it("the release gate and the floor fetch run before any token is read", () => {
        const i = (n: string) => steps(job).indexOf(named(job, n));
        const gate = named(job, "Release gate");
        expect(gate.if).toBe("${{ needs.resolve.outputs.kind == 'release' }}");
        expect(gate.run).toBe(
          `bash scripts/ci/tag-passed-checks.sh ${env} "$TAG"`,
        );
        expect(named(job, "Fetch the floor").if).toBe(
          "${{ needs.resolve.outputs.kind == 'floor' }}",
        );
        expect(named(job, "Fetch the floor").run).toContain(
          `bash scripts/ci/hosted-floor-fetch.sh ${env} "$RUN"`,
        );
        expect(i("Release gate")).toBeLessThan(i("Write the token files"));
        expect(i("Fetch the floor")).toBeLessThan(i("Write the token files"));
        expect(i("Write the token files")).toBe(i("Publish") - 1);
      });

      it("only the token step sees the secret; the R2 key is derived; files go whatever happened", () => {
        const withSecrets = steps(job).filter((s) =>
          JSON.stringify(s).includes("secrets."),
        );
        expect(withSecrets.map((s) => s.name)).toEqual([
          "Write the token files",
        ]);
        const tok = named(job, "Write the token files");
        expect(tok.env).toEqual({
          CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
        });
        expect(tok.run).toContain("umask 077");
        expect(tok.run).toContain('bash scripts/ci/hosted-r2-key.sh "$dir/r2"');
        const rm = named(job, "Remove the token files");
        expect(rm.if).toBe("${{ always() }}");
        expect(steps(job).at(-1)).toBe(rm);
      });

      it("publishes with oa:hosted for this env only", () => {
        const p = named(job, "Publish");
        expect(p.run).toContain(
          `release) pnpm -s oa:hosted publish-release --env ${env} --tag "$TAG" ;;`,
        );
        expect(p.run).toContain(
          `floor) pnpm -s oa:hosted publish-floor --env ${env} --floor "$FLOOR" ;;`,
        );
        expect(p.env.OA_HOSTED_ENVIRONMENT).toBe(`hosted-${env}-deploy`);
        const other = env === "prod" ? "staging" : "prod";
        expect(JSON.stringify(w.jobs[job])).not.toContain(`--env ${other}`);
        expect(named(job, "Load the hosted constants").run).toBe(
          `bash scripts/ci/hosted-constants.sh ${env} .github/hosted`,
        );
      });
    });
  }
});
