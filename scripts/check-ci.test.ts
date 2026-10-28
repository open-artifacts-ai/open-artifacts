import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const wf = (name: string): any => parse(read(`.github/workflows/${name}`));
// `on` is a plain key in YAML 1.2 (yaml package), so no boolean coercion.
const triggers = (w: { on: Record<string, unknown> }) => Object.keys(w.on);

/*
 * Invariants instead of pinned values (what changed and why):
 * - ci.yml triggers/jobs: exact lists -> "contains at least" (extra triggers
 *   or jobs, e.g. an audit job, must not break the suite). The five required
 *   check names stay mandatory.
 * - deploy-staging.yml: exact job list / trigger list -> contains; smoke
 *   `needs` must include deploy. Curl `--retry N --retry-delay N
 *   --retry-max-time N` numbers are tuning knobs -> matched by shape.
 * - landing-preview.yml: exact paths/types lists -> contains.
 * - release-please.yml: exact trigger list / permissions -> contains / at
 *   least write on these scopes; action pinned `@v4` -> any `@vN`.
 * - release-please-config: Manifest version: semver validity + equal to or ahead of the
 *   latest local v* git tag (skipped when no tags exist).
 * - package.json engines: exact ">=22" -> any ">=N" with N >= 22.
 * - ops-staging-access inputs: exact -> contains.
 * Kept as contracts: required check names, release-type node,
 * include-component-in-tag false, initial-version 0.1.0,
 * bump-minor-pre-major true (false would release 1.0.0), dispatch-only ops
 * workflow, shared "staging" concurrency, secret names/scoping, no tracing,
 * redirect/robots/CSP-style smoke assertions.
 */
const semver = (v: string) =>
  v.split(".").map(Number) as [number, number, number];
const cmp = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++)
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
};
const latestTag = (): string | undefined => {
  const tags = execFileSync("git", ["tag", "--list", "v*"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1))
    .sort(cmp);
  return tags.at(-1);
};
const ci = (n: string) => read(`scripts/ci/${n}`);
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
const A_TOK = "${{ secrets.ANALYTICS_TOKEN }}";
const RETRY_FLAGS = /--retry \d+ --retry-delay \d+ --retry-max-time \d+/;

describe("ci.yml", () => {
  const w = wf("ci.yml");
  it("triggers on pull_request and push to main", () => {
    expect(triggers(w)).toEqual(
      expect.arrayContaining(["pull_request", "push", "workflow_dispatch"]),
    );
    expect(w.on.push.branches).toContain("main");
    expect("workflow_dispatch" in w.on).toBe(true);
  });
  it("test: pull requests run the affected packages; everything else runs the full suite", () => {
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const steps: any[] = w.jobs.test.steps;
    const suite = steps.find((s) => s.id === "suite");
    expect(suite.run).toBe("bash scripts/ci/test-affected.sh");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(suite.env.BASE_SHA).toBe(
      "${{ github.event.pull_request.base.sha }}",
    );
    expect(suite.if).toContain("steps.ro.outputs.release_only != 'true'");
    expect(steps.some((s) => s.run === "pnpm test")).toBe(false);
    const cpu = steps.find((s) => (s.run ?? "").includes("test:cpu"));
    expect(cpu.if).toContain("steps.suite.outputs.server == 'true'");
    const sh = ci("test-affected.sh");
    expect(sh).toContain(
      '[ "${GITHUB_EVENT_NAME:-}" = pull_request ] || everything',
    );
    expect(sh).toContain('--filter "...[$BASE_SHA]"');
  });
  it("runs on merge_group so the merge queue gets its required checks", () => {
    expect(triggers(w)).toContain("merge_group");
  });
  it("defines at least the five required jobs", () => {
    expect(Object.keys(w.jobs)).toEqual(
      expect.arrayContaining(["build", "e2e", "lint", "test", "typecheck"]),
    );
  });
  // P3 T16 (#605): the authz matrix runs in its own job, in parallel, so the
  // main test job's wall time drops. Required check (repo setting).
  it("authz-matrix job runs the server authz matrix, gated and unskippable", () => {
    const job = w.jobs["authz-matrix"];
    expect(job).toBeDefined();
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("continue-on-error");
    expect(JSON.stringify(job)).not.toContain("secrets.");
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const runs = job.steps.map((s: any) => s.run ?? "");
    expect(runs).toContain("pnpm install --frozen-lockfile");
    expect(runs).toContain("pnpm --filter @oa/server test:authz");
  });
  it("lint job runs actionlint at a pinned version with checksum", () => {
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const step = w.jobs.lint.steps.find((s: any) =>
      (s.run ?? "").includes("actionlint"),
    );
    expect(step).toBeDefined();
    expect(step.env.ACTIONLINT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(step.env.ACTIONLINT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(step.run).not.toMatch(/latest/);
    expect(step.run).toContain("sha256sum -c");
    expect(step.run).toContain("command -v shellcheck");
    expect(step.run).toContain(".github/workflows/*.yml");
  });
  it("e2e job runs both Playwright suites locally, in the pinned Playwright image", () => {
    const job = w.jobs.e2e;
    // Browsers and their OS deps come baked into the image, pinned by digest:
    // no apt step, so a slow Ubuntu mirror can't eat the job's budget (#462).
    expect(job.container.image).toMatch(
      /^mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble@sha256:[0-9a-f]{64}$/,
    );
    expect(job.container.options ?? "").toContain("--ipc=host");
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(25);
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const steps: any[] = job.steps;
    const runs = steps.map((s) => s.run ?? "");
    const at = (needle: string) => runs.findIndex((r) => r.includes(needle));
    const order = [
      "pnpm install --frozen-lockfile",
      "e2e.sh version",
      "e2e.sh install",
      "e2e.sh hosts",
      "e2e.sh mock",
      "e2e.sh real",
    ].map(at);
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A mock failure must not skip the real suite; a failed browser install must.
    expect(steps[order[2] as number].id).toBe("install");
    expect(steps[order[5] as number].if).toMatch(
      /^\$\{\{ !cancelled\(\) && steps\.ro\.outputs\.release_only != 'true' && steps\.install\.outcome == 'success' \}\}$/,
    );
    // No browser cache and no --with-deps: the image already has both.
    expect(
      steps.some((s) => (s.with?.path ?? "").includes("ms-playwright")),
    ).toBe(false);
    // The image tag must be the version the dashboard pins.
    const img = /playwright:v(\d+\.\d+\.\d+)-noble/.exec(job.container.image);
    const pkg = JSON.parse(read("apps/dashboard/package.json"));
    expect(img?.[1]).toBe(pkg.devDependencies["@playwright/test"]);
    const upload = steps.find((s) =>
      (s.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    expect(upload.if).toBe("failure()");
    expect(upload.with.path).toContain("apps/dashboard/playwright-report");
    // Local wrangler dev only: no secrets, nothing pointing at staging.
    const s = JSON.stringify(job);
    expect(s).not.toContain("secrets.");
    expect(s).not.toContain("staging");
    expect(ci("e2e.sh")).not.toContain("--with-deps");
    expect(ci("e2e.sh")).toContain("PLAYWRIGHT_IMAGE_VERSION");
  });
  describe("release-only fast path", () => {
    const REQUIRED = [
      "lint",
      "typecheck",
      "test",
      "build",
      "e2e",
      "authz-matrix",
    ];
    const HEAVY = ["typecheck", "test", "build", "e2e", "authz-matrix"];
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    type Step = any;
    const raw = read(".github/workflows/ci.yml");
    const steps = (job: string): Step[] => w.jobs[job].steps;
    const ro = (job: string): Step =>
      steps(job).find((s) => s.id === "ro") as Step;

    it("the required job names still exist", () => {
      expect(Object.keys(w.jobs)).toEqual(expect.arrayContaining(REQUIRED));
    });
    it("no required job has a job-level if or needs (a skipped job counts as passing)", () => {
      for (const j of REQUIRED) {
        expect(w.jobs[j].if, `${j} if`).toBeUndefined();
        expect(w.jobs[j].needs, `${j} needs`).toBeUndefined();
      }
      expect(w.jobs.changes).toBeUndefined();
    });
    it("each heavy job checks out full history, then runs the release-only step first", () => {
      for (const j of HEAVY) {
        const [checkout, ...rest] = steps(j);
        expect(String(checkout.uses), j).toMatch(/^actions\/checkout@/);
        expect(checkout.with["fetch-depth"], j).toBe(0);
        expect(checkout.if, j).toBeUndefined();
        // only an ungated node setup may sit between the checkout and the step
        const before = rest.slice(0, rest.indexOf(ro(j)));
        for (const s of before) {
          expect(String(s.uses), j).toMatch(/^actions\/setup-node@/);
          expect(s.if, j).toBeUndefined();
        }
        expect(rest.indexOf(ro(j)), j).toBeGreaterThan(-1);
      }
    });
    it("the release-only step takes the script from the base sha, never the working tree, and fails closed", () => {
      for (const j of HEAVY) {
        const step = ro(j);
        expect(step.if, j).toBeUndefined();
        expect(step.env.BASE_SHA).toContain(
          "github.event.pull_request.base.sha",
        );
        expect(step.env.BASE_SHA).toContain(
          "github.event.merge_group.base_sha",
        );
        expect(step.env.HEAD_SHA).toContain(
          "github.event.pull_request.head.sha",
        );
        expect(step.env.HEAD_SHA).toContain(
          "github.event.merge_group.head_sha",
        );
        expect(step.run, j).toContain(
          'git show "$BASE_SHA:scripts/ci/release-only.ts"',
        );
        // the copy run is the base's, not scripts/ci/release-only.ts in the checkout
        expect(step.run, j).toContain("$RUNNER_TEMP/release-only.ts");
        expect(step.run, j).not.toMatch(
          /node [^\n]*\bscripts\/ci\/release-only\.ts/,
        );
        // any error or an output other than exactly release-only is full CI
        expect(step.run, j).toContain('[ "$out" = "release-only" ]');
        expect(step.run, j).toMatch(/rel=false/);
        expect(step.run, j).not.toMatch(/set -e\b/);
        // no secrets in this step
        expect(JSON.stringify(step)).not.toMatch(/secrets\./i);
      }
    });
    it("every heavy step is gated on that step's output, and the echo says main is protected, not that CI passed", () => {
      for (const j of HEAVY) {
        const all = steps(j);
        const note = all.find((s) => s.name === "release-only change");
        expect(note.if, j).toContain("steps.ro.outputs.release_only == 'true'");
        expect(note.run, j).toContain(
          "release-only change: skipped (the base commit is on main, which only the merge queue can update)",
        );
        expect(note.run, j).not.toMatch(/passed|CI at/);
        const gated = all.slice(all.indexOf(ro(j)) + 1);
        for (const s of gated) {
          if (s === note || String(s.if ?? "") === "failure()") continue;
          expect(
            String(s.if ?? ""),
            `${j}: ${s.name ?? s.run ?? s.uses}`,
          ).toContain("steps.ro.outputs.release_only != 'true'");
        }
      }
    });
    it("lint runs in full and checks version consistency", () => {
      expect(w.jobs.lint.needs).toBeUndefined();
      expect(steps("lint").every((s) => s.if === undefined)).toBe(true);
      expect(
        steps("lint").some((s) =>
          String(s.run ?? "").includes("version-consistency.ts"),
        ),
      ).toBe(true);
    });
    it("the fast path is gated only on the release-only step's output, never on labels, the branch name or the author", () => {
      const conds = Object.values(w.jobs).flatMap((j) => {
        const job = j as { if?: unknown; steps?: Step[] };
        return [job.if, ...(job.steps ?? []).map((s) => s.if)].map(String);
      });
      for (const c of conds.filter((c) => c.includes("release_only")))
        expect(c).toMatch(/steps\.ro\.outputs\.release_only/);
      for (const j of HEAVY)
        for (const s of steps(j))
          expect(JSON.stringify([s.if, s.env, s.run])).not.toMatch(
            /labels|head_ref|ref_name|actor|\.user\.|author|release-please--|startsWith\(github\.ref/,
          );
      expect(raw).not.toMatch(/contains\(.*labels/);
    });
  });
  // H-RD: provision's src and dist import @oa/auth-core/domains, which node
  // resolves to auth-core's dist. A job that runs provision code must build it
  // first (`pnpm --filter @oa/provision build` does, or build auth-core).
  it("every job that runs provision tests or its dist builds @oa/auth-core first", () => {
    const usesProvision =
      /@oa\/provision (?:exec vitest|test)\b|scripts\/ci\/build-(?:release-bundle|hosted-release)\.ts/;
    const builds =
      /--filter @oa\/(?:provision|auth-core) build\b|--filter @oa\/auth-core\b[^\n]*\bbuild\b/;
    const seen: string[] = [];
    for (const name of readdirSync(join(root, ".github/workflows")).filter(
      (f) => f.endsWith(".yml"),
    ))
      for (const [job, j] of Object.entries(wf(name).jobs ?? {}))
        for (const [i, st] of (
          (j as { steps?: { run?: string }[] }).steps ?? []
        ).entries()) {
          const run = st.run ?? "";
          const at = run.search(usesProvision);
          if (at < 0) continue;
          seen.push(`${name}:${job}`);
          const before = [
            ...(j as { steps: { run?: string }[] }).steps
              .slice(0, i)
              .map((x) => x.run ?? ""),
            run.slice(0, at),
          ].join("\n");
          expect(builds.test(before), `${name}:${job}`).toBe(true);
        }
    expect(seen.length).toBeGreaterThan(0);
  });

  it("uses node from .nvmrc with pnpm cache", () => {
    const raw = read(".github/workflows/ci.yml");
    expect(raw).toContain("node-version-file: .nvmrc");
    expect(raw).toContain("cache: pnpm");
  });
});

describe("deploy-staging.yml", () => {
  const w = wf("deploy-staging.yml");
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  type Step = any;
  const runs = (id: string): string[] =>
    w.jobs[id].steps.map((s: Step) => s.run ?? "");
  const idx = (id: string, needle: string) =>
    runs(id).findIndex((r) => r.includes(needle));
  it("triggers on push to main with serialized staging concurrency", () => {
    expect(triggers(w)).toContain("push");
    expect(w.on.push.branches).toContain("main");
    expect(w.concurrency).toEqual({
      group: "staging",
      "cancel-in-progress": false,
    });
  });
  it("has deploy then smoke jobs", () => {
    expect(Object.keys(w.jobs)).toEqual(
      expect.arrayContaining(["deploy", "smoke"]),
    );
    expect([w.jobs.smoke.needs].flat()).toContain("deploy");
  });
  it("deploy steps run build -> migrate -> deploy in order", () => {
    const b = idx("deploy", "pnpm build");
    const m = idx("deploy", "d1 migrations apply open-artifacts-staging");
    const d = idx("deploy", "wrangler deploy");
    expect(b).toBeGreaterThan(-1);
    expect(m).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(m);
    const migrate = runs("deploy")[m] as string;
    const deploy = runs("deploy")[d] as string;
    expect(migrate).toContain("--remote");
    for (const c of [migrate, deploy]) {
      expect(c).toContain("--env staging");
      expect(c).toContain("wrangler.staging.jsonc");
    }
  });
  it("preflights required Worker secrets before migrate and deploy", () => {
    const p = idx("deploy", "staging-preflight.sh");
    expect(p).toBeGreaterThan(idx("deploy", "pnpm build"));
    expect(p).toBeLessThan(idx("deploy", "d1 migrations apply"));
    expect(p).toBeLessThan(idx("deploy", "wrangler deploy"));
    expect(runs("deploy")[p]).toContain("scripts/ci/staging-preflight.sh");
    const step = ci("staging-preflight.sh");
    expect(step).toContain("check-staging-secrets");
    expect(step).toContain("wrangler secret list");
    expect(step).toContain("--format json");
    expect(step).toContain("set -euo pipefail");
    expect(step).toContain("wrangler.staging.jsonc");
    expect(step).toContain("--env staging");
  });
  it("clears conflicting secrets after preflight and before deploy", () => {
    const p = idx("deploy", "staging-preflight.sh");
    const c = idx("deploy", "staging-clear-conflicts.sh");
    expect(c).toBeGreaterThan(p);
    expect(c).toBeLessThan(idx("deploy", "wrangler deploy"));
    const step = ci("staging-clear-conflicts.sh");
    expect(step).toContain("conflicting-secrets");
    expect(step).toContain("set -euo pipefail");
    expect(step).toContain("wrangler secret list");
    expect(step).toContain(
      'wrangler secret delete "$name" -c wrangler.staging.jsonc --env staging',
    );
    expect(step).toContain("echo y |");
  });
  it("ensures dashboard dist exists before wrangler deploy", () => {
    const e = idx("deploy", "ensure-dashboard-dist.sh");
    expect(e).toBeGreaterThan(idx("deploy", "pnpm build"));
    expect(e).toBeLessThan(idx("deploy", "wrangler deploy"));
    expect(ci("ensure-dashboard-dist.sh")).toContain("index.html");
  });
  it("smoke asserts /auth/login redirects to Cloudflare Access", () => {
    const all = runs("smoke").join("\n") + ci("staging-smoke.sh");
    expect(all).toContain(
      "staging-smoke.sh login https://staging.open-artifacts.com",
    );
    expect(all).toContain("/auth/login");
    expect(all).toMatch(RETRY_FLAGS);
    expect(all).not.toMatch(/\s-[a-zA-Z]*L\b|--location/);
    expect(all).toContain("302");
    expect(all).toContain(
      `sed -n 's/.*"ACCESS_TEAM_DOMAIN": *"\\([^"]*\\)".*/\\1/p' "$config" | head -1`,
    );
    expect(all).toContain("tr -d '\\r'");
    expect(all).toContain("grep -i '^location:'");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell
    expect(all).toContain('[ "${loc#"$prefix"}" != "$loc" ]');
    expect(all).toContain('prefix="https://$team/cdn-cgi/access/sso/oidc/"');
    expect(all).toContain("END{print b}");
    expect(all).toMatch(/[Ll]ocation/);
  });
  it("smoke checks robots on the content host", () => {
    const all = runs("smoke").join("\n");
    expect(all).toContain("robots https://staging-content.open-artifacts.com");
  });
  it("migrate, deploy and smoke are never skippable or tolerated", () => {
    for (const id of ["deploy", "smoke"]) {
      expect(w.jobs[id].if).toBeUndefined();
      expect(w.jobs[id]["continue-on-error"]).toBeUndefined();
      for (const st of w.jobs[id].steps) {
        expect(st.if).toBeUndefined();
        expect(st["continue-on-error"]).toBeUndefined();
        expect(st.run ?? "").not.toContain("|| true");
      }
    }
  });
  it("smoke checks healthz, robots and runs the smoke suite", () => {
    const all = runs("smoke").join("\n") + ci("staging-smoke.sh");
    expect(all).toContain("healthz https://staging.open-artifacts.com");
    expect(all).toMatch(RETRY_FLAGS);
    expect(all).not.toMatch(/\|\s*grep/);
    expect(all).toContain("/robots.txt");
    expect(all).toContain("noindex, nofollow");
    expect(all).toContain("Disallow: /");
    expect(all).toContain("@oa/server smoke");
  });
  it("sets ANALYTICS_TOKEN after deploy and before smoke, step-scoped", () => {
    const steps = w.jobs.deploy.steps as Step[];
    const a = idx("deploy", "staging-analytics-token.sh");
    expect(a).toBeGreaterThan(idx("deploy", "wrangler deploy"));
    expect([w.jobs.smoke.needs].flat()).toContain("deploy");
    expect(steps[a]["working-directory"]).toBe("apps/server");
    expect(steps[a].env).toEqual({
      ANALYTICS_TOKEN: A_TOK,
    });
    const scoped = steps.filter((s: Step) =>
      JSON.stringify(s).includes("secrets.ANALYTICS_TOKEN"),
    );
    expect(scoped).toHaveLength(1);
    expect(JSON.stringify(w.jobs.deploy.env)).not.toContain("ANALYTICS");
    expect(JSON.stringify(w.jobs.smoke)).not.toContain("secrets.ANALYTICS");
    const sh = ci("staging-analytics-token.sh");
    expect(sh).toContain('printf %s "$ANALYTICS_TOKEN" |');
    expect(sh).toContain(
      "wrangler secret put ANALYTICS_TOKEN -c wrangler.staging.jsonc --env staging",
    );
    expect(sh).not.toMatch(/echo[^\n]*\$\{?ANALYTICS_TOKEN/);
    expect(sh).not.toMatch(/set -[a-z]*x/);
  });
  it("a failed ANALYTICS_TOKEN put still runs smoke, then fails the run", () => {
    const steps = w.jobs.deploy.steps as Step[];
    const a = steps[idx("deploy", "staging-analytics-token.sh")];
    expect(a.id).toBe("analytics");
    expect(w.jobs.deploy.outputs?.analytics).toBe(
      "${{ steps.analytics.outputs.analytics }}",
    );
    const s = w.jobs.smoke.steps as Step[];
    const o = s.findIndex((x: Step) =>
      (x.run ?? "").includes("staging-analytics-token.sh outcome"),
    );
    expect(o).toBe(s.length - 1);
    expect(s[o].env).toEqual({
      ANALYTICS_OUTCOME: "${{ needs.deploy.outputs.analytics }}",
    });
    const sh = ci("staging-analytics-token.sh");
    expect(sh).toContain("::error::");
    expect(sh).toContain('>>"$out"');
  });
  it("uses Cloudflare secrets", () => {
    const raw = read(".github/workflows/deploy-staging.yml");
    expect(raw).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(raw).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("landing-preview.yml", () => {
  const w = wf("landing-preview.yml");
  const raw = read(".github/workflows/landing-preview.yml");
  const sameRepo =
    "github.event.pull_request.head.repo.full_name == github.repository";
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  const steps = w.jobs.preview.steps as any[];
  it("triggers on PRs touching apps/landing, incl. closed", () => {
    expect(triggers(w)).toEqual(["pull_request"]);
    expect(w.on.pull_request.paths).toContain("apps/landing/**");
    expect(w.on.pull_request.types).toEqual(
      expect.arrayContaining(["opened", "synchronize", "reopened", "closed"]),
    );
  });
  it("skips fork PRs and closed events in the preview job", () => {
    expect(w.jobs.preview.if).toContain(sameRepo);
    expect(w.jobs.preview.if).toContain("github.event.action != 'closed'");
  });
  it("serializes per PR", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(w.concurrency.group).toBe(
      "landing-preview-${{ github.event.pull_request.number }}",
    );
  });
  it("uses wrangler preview, never versions upload", () => {
    const script = ci("landing-preview-url.sh");
    expect(script).toContain('wrangler preview --name "pr-$pr"');
    expect(script).toContain("--json");
    expect(raw).not.toContain("versions upload");
    expect(script).not.toContain("versions upload");
  });
  it("gates early and fails without a URL", () => {
    expect(steps.some((s) => s.id === "gate")).toBe(true);
    const install = steps.find((s) => (s.run ?? "").includes("pnpm install"));
    expect(install.if).toContain("steps.gate.outputs.present");
    const prev = steps.find((s) => s.id === "preview");
    expect(prev.run).toContain("scripts/ci/landing-preview-url.sh");
    expect(ci("landing-preview-url.sh")).toContain("jq -er");
    expect(prev.run).not.toContain("|| true");
    expect(ci("landing-preview-url.sh")).not.toContain("|| true");
  });
  it("hides the wrangler banner and extracts JSON from stdout", () => {
    const prev = steps.find((s) => s.id === "preview");
    expect(prev.env.WRANGLER_HIDE_BANNER).toBe("true");
    const script = ci("landing-preview-url.sh");
    expect(script).toContain("sed -n '/^{/,$p'");
    expect(script).toContain("cat preview.json");
  });
  it("scopes the Cloudflare token to the preview step only", () => {
    expect(w.jobs.preview.env).toBeUndefined();
    expect(w.env).toBeUndefined();
    const prev = steps.find((s) => s.id === "preview");
    expect(prev.env.CLOUDFLARE_API_TOKEN).toContain(
      "secrets.CLOUDFLARE_API_TOKEN",
    );
    const others = steps.filter((s) => s.id !== "preview");
    expect(JSON.stringify(others)).not.toContain("CLOUDFLARE_API_TOKEN");
  });
  it("updates one sticky comment via marker", () => {
    const gh = steps.find((s) => s.uses?.startsWith("actions/github-script"));
    expect(gh.env.PREVIEW_URL).toBeDefined();
    expect(gh.with.script).toContain("<!-- landing-preview -->");
    expect(gh.with.script).toContain("updateComment");
    expect(gh.with.script).toContain("createComment");
    expect(gh.with.script).not.toContain("${{");
  });
  it("deletes the preview when the PR closes", () => {
    const c = w.jobs.cleanup;
    expect(c.if).toContain(sameRepo);
    expect(c.if).toContain("github.event.action == 'closed'");
    expect(raw).toContain("wrangler preview delete --name pr-");
    expect(raw).toContain("--skip-confirmation");
    expect(JSON.stringify(c.steps)).toContain("steps.gate.outputs.present");
  });
});

describe("release-please", () => {
  it("workflow triggers on push to main; every job sets its own permissions", () => {
    const w = wf("release-please.yml");
    expect(triggers(w)).toEqual(
      expect.arrayContaining(["push", "workflow_dispatch"]),
    );
    expect(w.on.push.branches).toContain("main");
    // T3b: no workflow-wide grant. release-please writes with the release
    // App's token, so its GITHUB_TOKEN only reads; only hosted-attach writes.
    expect(w.permissions).toEqual({});
    // release-please uses the App token (token: steps.app.outputs.token) and
    // nothing uses GITHUB_TOKEN, so it gets none.
    expect(w.jobs["release-please"].permissions).toEqual({});
    expect(read(".github/workflows/release-please.yml")).toMatch(
      /googleapis\/release-please-action@v\d+/,
    );
  });
  it("deploys the tag", () => {
    const raw = read(".github/workflows/release-please.yml");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(raw).toContain("needs.release-please.outputs.tag_name");
    const gate = wf("release-please.yml").jobs["deploy-landing"].steps;
    expect(JSON.stringify(gate)).toContain("steps.gate.outputs.present");
  });
  it("release-please job queues back-to-back pushes; no other job is serialized behind it", () => {
    const w = wf("release-please.yml");
    expect(w.jobs["release-please"].concurrency).toEqual({
      group: "release-please",
      "cancel-in-progress": false,
    });
    expect(w.concurrency).toBeUndefined();
    for (const [name, job] of Object.entries(w.jobs))
      if (name !== "release-please")
        expect(
          // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
          JSON.stringify((job as any).concurrency ?? {}),
          name,
        ).not.toContain('"release-please"');
  });

  it("release-please opens its PR with the release App token, so CI runs on it", () => {
    // PRs and pushes made with GITHUB_TOKEN trigger no workflows; an App token's do.
    const steps = wf("release-please.yml").jobs["release-please"].steps;
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const app = steps.find((s: any) =>
      /^actions\/create-github-app-token@v\d+$/.test(s.uses ?? ""),
    );
    expect(app?.id).toBe("app");
    expect(app.with).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "app-id": "${{ secrets.RELEASE_APP_ID }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "private-key": "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
    });
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const rp = steps.find((s: any) => s.id === "rp");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(rp.with.token).toBe("${{ steps.app.outputs.token }}");
    expect(steps.indexOf(app)).toBeLessThan(steps.indexOf(rp));
  });
  it("has no dispatch workaround for the release PR", () => {
    const raw = read(".github/workflows/release-please.yml");
    expect(raw).not.toContain("release-pr-dispatch");
    expect(raw).not.toContain("gh workflow run");
    expect(existsSync(join(root, "scripts/ci/release-pr-dispatch.sh"))).toBe(
      false,
    );
    expect(wf("release-please.yml").permissions.actions).toBeUndefined();
  });
  it("deploy-landing uses no scripts/ci files (older tags lack them)", () => {
    const steps = wf("release-please.yml").jobs["deploy-landing"].steps;
    expect(JSON.stringify(steps)).not.toContain("scripts/ci");
  });
  it("gates landing deploy on a release-ready dist, between build and deploy", () => {
    const steps = wf("release-please.yml").jobs["deploy-landing"].steps;
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const runs: string[] = steps.map((s: any) => s.run ?? "");
    const at = (n: string) => runs.findIndex((r) => r.includes(n));
    const b = at("pnpm --filter @oa/landing build");
    const g = at("scripts/ops/check-landing-dist.ts");
    const d = at("wrangler deploy");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(g).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(g);
    expect(runs[b]).not.toContain("wrangler deploy");
    expect(read(".github/workflows/release-please.yml")).toContain(
      "failing here does not undo the release",
    );
  });
  it("workflow_dispatch takes a tag and runs only deploy-landing", () => {
    const w = wf("release-please.yml");
    expect(w.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(w.jobs["release-please"].if).toContain("push");
    const d = w.jobs["deploy-landing"];
    expect(d.if).toContain("workflow_dispatch");
    expect(JSON.stringify(d.steps)).toContain("inputs.tag");
  });
  it("config is release-type node, manifest has a single semver at '.'", () => {
    const c = JSON.parse(read("release-please-config.json"));
    expect(c.packages["."]["release-type"]).toBe("node");
    // Must stay true: main has BREAKING CHANGES; false would release 1.0.0.
    expect(c.packages["."]["bump-minor-pre-major"]).toBe(true);
    const m = JSON.parse(read(".release-please-manifest.json"));
    expect(Object.keys(m)).toEqual(["."]);
    expect(m["."]).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("manifest version is the latest v* tag or ahead of it", () => {
    const tag = latestTag();
    if (!tag) return; // no tags locally (e.g. shallow clone): nothing to compare
    const m = JSON.parse(read(".release-please-manifest.json"));
    expect(cmp(m["."], tag)).toBeGreaterThanOrEqual(0);
  });
  it("first release is 0.1.0 via initial-version", () => {
    const c = JSON.parse(read("release-please-config.json"));
    expect(c.packages["."]["initial-version"]).toBe("0.1.0");
  });
  it("release tags are vX.Y.Z without the component prefix", () => {
    const c = JSON.parse(read("release-please-config.json"));
    expect(c.packages["."]["include-component-in-tag"]).toBe(false);
  });
});

describe(".nvmrc", () => {
  it("pins Node >= 22 because wrangler 4 requires it", () => {
    const major = Number.parseInt(read(".nvmrc").trim().replace(/^v/, ""), 10);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});

describe("package.json engines", () => {
  it("requires Node >=22 in every tracked package.json", () => {
    const files = execFileSync("git", ["ls-files", "*package.json"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const node: string | undefined = JSON.parse(read(f)).engines?.node;
      const major = Number(/^>=\s*(\d+)/.exec(node ?? "")?.[1]);
      expect([f, major >= 22]).toEqual([f, true]);
    }
  });
});

describe("ops-staging-access.yml", () => {
  const w = wf("ops-staging-access.yml");
  const raw = read(".github/workflows/ops-staging-access.yml");
  it("is workflow_dispatch only", () => {
    expect(triggers(w)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual(
      expect.arrayContaining(["force_rotate", "team_name"]),
    );
  });
  it("never enables shell tracing", () => {
    expect(raw).not.toMatch(/set\s+-[a-wyz]*x/);
    expect(raw).not.toMatch(/set\s+-o\s+xtrace/);
  });
  it("runs the tested script with Cloudflare secrets", () => {
    expect(raw).toContain("scripts/ops/staging-access.ts");
    expect(raw).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(raw).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("ops-staging-token-id.yml", () => {
  const w = wf("ops-staging-token-id.yml");
  const raw = read(".github/workflows/ops-staging-token-id.yml");
  it("is workflow_dispatch only and runs on main", () => {
    expect(triggers(w)).toEqual(["workflow_dispatch"]);
    expect(w.jobs.id.if).toBe("github.ref == 'refs/heads/main'");
  });
  it("serializes with other staging ops and times out", () => {
    expect(w.concurrency).toEqual({
      group: "staging",
      "cancel-in-progress": false,
    });
    expect(w.jobs.id["timeout-minutes"]).toBeLessThanOrEqual(5);
  });
  it("passes the staging token only to the tested script step", () => {
    expect(raw).toContain("scripts/ops/staging-token-id.sh");
    expect(w.jobs.id.env).toBeUndefined();
    expect(raw.match(/secrets\./g)).toHaveLength(1);
    expect(raw).toContain("secrets.CLOUDFLARE_API_TOKEN");
  });
});

describe("ops-staging-access.yml hardening", () => {
  const w = wf("ops-staging-access.yml");
  it("keeps the Cloudflare token out of job-level env", () => {
    expect(w.jobs.access.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(w.jobs.access.env?.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const prov = w.jobs.access.steps.find((s: any) =>
      (s.run ?? "").includes("scripts/ops/staging-access.ts"),
    );
    expect(Object.keys(prov.env)).toEqual(
      expect.arrayContaining(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]),
    );
  });
  it("shares the staging concurrency group with deploy-staging", () => {
    const want = { group: "staging", "cancel-in-progress": false };
    expect(w.concurrency).toEqual(want);
    expect(wf("deploy-staging.yml").concurrency).toEqual(want);
  });
  it("only runs on main", () => {
    expect(w.jobs.access.if).toBe("github.ref == 'refs/heads/main'");
  });
});

describe("prod and staging tokens never cross", () => {
  const dir = join(root, ".github/workflows");
  const refs = (file: string, base = dir): Set<string> => {
    const out = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === "string")
        for (const m of v.matchAll(/secrets\.([A-Za-z0-9_]+)/g))
          out.add(m[1] as string);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(parse(readFileSync(join(base, file), "utf8")));
    return out;
  };
  // Returns violations for every workflow file in `base`.
  const violations = (base: string) => {
    const bad: string[] = [];
    for (const f of readdirSync(base).filter((n) => /\.ya?ml$/.test(n))) {
      const r = refs(f, base);
      const isProd = f.includes("prod");
      if (!isProd && r.has("PROD_CLOUDFLARE_API_TOKEN")) {
        // Exception: a job named deploy-prod, in a file whose other jobs never touch the PROD secret.
        const jobs = (parse(readFileSync(join(base, f), "utf8")).jobs ??
          {}) as Record<string, unknown>;
        for (const [name, job] of Object.entries(jobs)) {
          const s = JSON.stringify(job);
          if (s.includes("secrets.PROD_CLOUDFLARE_API_TOKEN")) {
            if (name !== "deploy-prod")
              bad.push(`${f}: job ${name} uses PROD_CLOUDFLARE_API_TOKEN`);
            else if (/secrets\.CLOUDFLARE_API_TOKEN/.test(s))
              bad.push(`${f}: job ${name} mixes PROD and staging tokens`);
          }
        }
      }
      if (isProd && r.has("CLOUDFLARE_API_TOKEN"))
        bad.push(`${f}: prod workflow uses CLOUDFLARE_API_TOKEN`);
    }
    return bad;
  };
  it("real workflows have no crossings", () => {
    expect(violations(dir)).toEqual([]);
  });
  it("staging workflows never reference the PROD secret", () => {
    for (const f of [
      "deploy-staging.yml",
      "ops-staging-access.yml",
      "ops-staging-token-id.yml",
      "landing-preview.yml",
    ])
      expect(refs(f), f).not.toContain("PROD_CLOUDFLARE_API_TOKEN");
  });
  it("the prod check workflow uses the PROD secret", () => {
    expect(refs("ops-prod-token-check.yml")).toContain(
      "PROD_CLOUDFLARE_API_TOKEN",
    );
  });
  describe("ops-prod-install.yml", () => {
    const f = "ops-prod-install.yml";
    const w = wf(f);
    const text = readFileSync(join(dir, f), "utf8");
    const steps = w.jobs.install.steps as {
      name?: string;
      env?: Record<string, string>;
      run?: string;
    }[];
    it("is dispatch-only and main-only", () => {
      expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
      expect(w.jobs.install.if).toBe("github.ref == 'refs/heads/main'");
    });
    it("has a stable-tag guard step", () => {
      const g = steps.find((s) => /stable/i.test(s.name ?? ""));
      expect(g?.run).toContain("releases/latest");
    });
    it("has an always() revoke step using only the PROD token", () => {
      const r = steps.find((s) => s.run?.includes("--revoke-ci-tokens")) as any;
      expect(r).toBeDefined();
      expect(r.if).toBe("always()");
      expect(r["continue-on-error"]).toBe(false);
      expect(r["timeout-minutes"]).toBe(3);
      expect(r.env.CLOUDFLARE_API_TOKEN).toBe(
        "${{ secrets.PROD_CLOUDFLARE_API_TOKEN }}",
      );
      expect(JSON.stringify(r.env)).not.toMatch(
        /secrets\.CLOUDFLARE_API_TOKEN/,
      );
    });
    it("scopes tokens to the setup step and uses --ci", () => {
      const withTok = steps.filter((s) =>
        JSON.stringify(s.env ?? {}).includes("secrets."),
      );
      expect(withTok).toHaveLength(2);
      expect(withTok[0]?.env).toHaveProperty("OA_ACCESS_TOKEN");
      expect(w.env ?? {}).not.toHaveProperty("OA_ACCESS_TOKEN");
      expect(text).not.toMatch(/secrets\.CLOUDFLARE_API_TOKEN/);
      expect(text).toContain("--ci");
      expect([...refs(f)].sort()).toEqual([
        "ANALYTICS_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
        "PROD_CLOUDFLARE_API_TOKEN",
      ]);
    });
    it("passes ANALYTICS_TOKEN to the setup step only", () => {
      const withA = steps.filter((s) =>
        JSON.stringify(s).includes("secrets.ANALYTICS_TOKEN"),
      );
      expect(withA.map((s) => s.run)).toEqual([
        "bash scripts/ci/prod-setup.sh install",
      ]);
      expect(withA[0]?.env?.ANALYTICS_TOKEN).toBe(A_TOK);
    });
  });
  describe("release-please.yml deploy-prod", () => {
    const f = "release-please.yml";
    const w = wf(f);
    const job = w.jobs["deploy-prod"];
    const steps = job.steps as {
      id?: string;
      name?: string;
      if?: string;
      uses?: string;
      with?: Record<string, unknown>;
      env?: Record<string, string>;
      run?: string;
    }[];
    const tok = "${{ secrets.PROD_CLOUDFLARE_API_TOKEN }}";
    it("only the deploy-prod job references the PROD secret", () => {
      for (const [n, j] of Object.entries(w.jobs))
        expect(JSON.stringify(j).includes("PROD_CLOUDFLARE_API_TOKEN"), n).toBe(
          n === "deploy-prod",
        );
      expect(job.env ?? {}).not.toHaveProperty("OA_ACCESS_TOKEN");
      expect(JSON.stringify(job.env ?? {})).not.toContain("secrets.");
    });
    it("runs only on a release event or main-ref dispatch, never a bare push", () => {
      expect(job.if).toContain("release_created == 'true'");
      expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
      expect(job.needs).toEqual(["release-please"]);
      expect(job.if).not.toMatch(/event_name == 'push'/);
      expect(job.concurrency).toEqual({
        group: "prod",
        "cancel-in-progress": false,
      });
    });
    it("guards stable-only (prerelease and latest)", () => {
      const g = steps.find((s) => s.id === "guard");
      expect(g?.run).toContain("isPrerelease");
      expect(g?.run).toContain("releases/latest");
      expect(g?.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    });
    it("preflight, then --ci upgrade, then always() cleanup; step-scoped token", () => {
      const at = (m: string) => steps.findIndex((s) => s.run?.includes(m));
      const [pre, up, cl] = [
        at("prod-setup.sh preflight"),
        at("prod-setup.sh upgrade"),
        at("prod-setup.sh cleanup"),
      ];
      expect(pre).toBeGreaterThan(0);
      expect(up).toBeGreaterThan(pre);
      expect(cl).toBeGreaterThan(up);
      expect(steps[cl]?.if).toContain("always()");
      expect(steps[pre]?.if ?? "").not.toContain("always()");
      expect(steps[up]?.if ?? "").not.toContain("always()");
      const withTok = steps.filter((s) =>
        JSON.stringify(s.env ?? {}).includes("secrets."),
      );
      // setup's three steps carry both tokens; the migration guard's record,
      // verify and restore steps carry the Cloudflare token only.
      const setup = withTok.filter((s) => s.run?.includes("prod-setup.sh"));
      expect(setup).toHaveLength(3);
      for (const s of setup) {
        expect(s.env?.CLOUDFLARE_API_TOKEN).toBe(tok);
        expect(s.env?.OA_ACCESS_TOKEN).toBe(tok);
      }
      const guard = withTok.filter((s) =>
        s.run?.includes("prod-migration-guard.sh"),
      );
      expect(guard.map((s) => s.run)).toEqual([
        "bash scripts/ci/prod-migration-guard.sh record",
        "bash scripts/ci/prod-migration-guard.sh verify",
        "bash scripts/ci/prod-migration-guard.sh restore",
      ]);
      for (const s of guard) {
        expect(s.env?.CLOUDFLARE_API_TOKEN).toBe(tok);
        expect(s.env).not.toHaveProperty("OA_ACCESS_TOKEN");
      }
      expect(withTok).toHaveLength(setup.length + guard.length);
      const sh = readFileSync(join(root, "scripts/ci/prod-setup.sh"), "utf8");
      expect(sh).toContain(
        'upgrade) mode_args=(--ci --upgrade "${EMAIL_SWITCH[@]}" --browser --plan paid)',
      );
      expect(sh).toContain(
        'install) mode_args=(--ci "${EMAIL_SWITCH[@]}" --browser --plan paid)',
      );
      expect(sh).toContain(
        'preflight) mode_args=(--check --strict --upgrade "${EMAIL_SWITCH[@]}" --browser --plan paid)',
      );
      expect(sh).toContain(
        "EMAIL_SWITCH=(--team --yes-paid --email-domain mail.leourbina.com)",
      );
      expect(sh).toContain("--ci --revoke-ci-tokens");
    });
    // A release that adds a `-- oa:non-additive` migration (a table rebuild)
    // is held from the automatic deploy; a manual run deploys it guarded.
    it("non-additive migration guard: held unless manual; record, upgrade, verify, then restore only when allowed", () => {
      const at = (m: string) => steps.findIndex((s) => s.run?.includes(m));
      const idx = (id: string) => steps.findIndex((s) => s.id === id);
      const checkout = steps.find((s) =>
        String(s.uses).startsWith("actions/checkout@"),
      );
      expect(checkout?.with?.["fetch-depth"]).toBe(0);
      const det = idx("migration");
      expect(steps[det]?.run).toBe(
        "bash scripts/ci/prod-migration-guard.sh detect",
      );
      expect(det).toBeGreaterThan(at("pnpm install --frozen-lockfile"));
      // Every step after the guard needs an explicit hold == 'false' (a guard
      // that didn't run deploys nothing).
      for (const s of steps
        .slice(det + 1)
        .filter((s) => s.run && !s.if?.startsWith("failure()")))
        expect(s.if, s.name ?? s.run).toContain(
          "steps.migration.outputs.hold == 'false'",
        );
      const [rec, up, ver] = [
        idx("record"),
        at("prod-setup.sh upgrade"),
        idx("verify"),
      ];
      expect(rec).toBeGreaterThan(at("prod-setup.sh preflight"));
      expect(up).toBeGreaterThan(rec);
      expect(ver).toBeGreaterThan(up);
      for (const i of [rec, ver])
        expect(steps[i]?.if).toContain(
          "steps.migration.outputs.guarded == 'true'",
        );
      const restore = steps[at("prod-migration-guard.sh restore")];
      const page = steps.find((s) => s.name?.startsWith("Page"));
      expect(at("prod-migration-guard.sh restore")).toBeGreaterThan(ver);
      expect(restore?.if).toBe(
        "failure() && steps.migration.outputs.guarded == 'true' && steps.record.outcome == 'success' && inputs.restore_on_failure == true",
      );
      expect(page?.if).toBe(
        "failure() && steps.migration.outputs.guarded == 'true' && steps.record.outcome == 'success' && inputs.restore_on_failure != true",
      );
      expect(JSON.stringify(page?.env ?? {})).not.toContain("secrets.");
      expect(w.on.workflow_dispatch.inputs.restore_on_failure).toMatchObject({
        type: "boolean",
        default: false,
      });
    });
    it("passes ANALYTICS_TOKEN to the upgrade step only", () => {
      const withA = steps.filter((s) =>
        JSON.stringify(s).includes("secrets.ANALYTICS_TOKEN"),
      );
      expect(withA.map((s) => s.run)).toEqual([
        "bash scripts/ci/prod-setup.sh upgrade",
      ]);
      expect(withA[0]?.env?.ANALYTICS_TOKEN).toBe(A_TOK);
      for (const [n, j] of Object.entries(w.jobs))
        if (n !== "deploy-prod")
          expect(JSON.stringify(j), n).not.toContain("ANALYTICS_TOKEN");
    });
    it("deploy-landing stays independent of deploy-prod", () => {
      expect(w.jobs["deploy-landing"].needs).toEqual(["release-please"]);
      expect(JSON.stringify(w.jobs["deploy-landing"])).not.toContain(
        "deploy-prod",
      );
    });
  });
  const secretInRun = (run: string) => /secrets\.ANALYTICS_TOKEN/.test(run);
  it("the run: check catches any spacing", () => {
    for (const r of [
      "echo ${{secrets.ANALYTICS_TOKEN}}",
      "echo ${{ secrets.ANALYTICS_TOKEN }}",
      "echo ${{   secrets.ANALYTICS_TOKEN\t}}",
    ])
      expect(secretInRun(r), r).toBe(true);
    expect(secretInRun("bash x.sh")).toBe(false);
  });
  it("ANALYTICS_TOKEN never appears in run: text or workflow/job env", () => {
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      const y = parse(readFileSync(join(dir, f), "utf8"));
      expect(JSON.stringify(y.env ?? {}), f).not.toContain("ANALYTICS");
      // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
      for (const [n, j] of Object.entries(y.jobs ?? {}) as [string, any][]) {
        expect(JSON.stringify(j.env ?? {}), `${f} ${n}`).not.toContain(
          "ANALYTICS",
        );
        for (const st of j.steps ?? [])
          expect(secretInRun(st.run ?? ""), `${f} ${n}`).toBe(false);
      }
    }
  });
  it("detects a crossing fixture", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wf-"));
    writeFileSync(
      join(tmp, "deploy-prod.yml"),
      "on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: x\n        env:\n          A: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n",
    );
    writeFileSync(
      join(tmp, "stage.yml"),
      "on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: x\n        env:\n          A: ${{ secrets.PROD_CLOUDFLARE_API_TOKEN }}\n",
    );
    expect(violations(tmp)).toHaveLength(2);
  });
});

describe("workflow jobs that use repo files have a checkout", () => {
  const usesRepo = (s: { run?: string; "working-directory"?: string }) =>
    /(^|[\s"'=])(\.\/|(\.\.\/)+)?scripts\//.test(s.run ?? "") ||
    /(^|[\s"'=])(\.\.\/)+scripts\//.test(s.run ?? "") ||
    (!!s["working-directory"] &&
      !/^(\/|~|\$|\$\{\{)/.test(s["working-directory"]));
  const dir = join(root, ".github/workflows");
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    for (const [job, def] of Object.entries(
      // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
      (wf(file).jobs ?? {}) as Record<string, any>,
    )) {
      it(`${file} job ${job}`, () => {
        let checkedOut = false;
        const bad: string[] = [];
        for (const s of def.steps ?? []) {
          if (String(s.uses ?? "").startsWith("actions/checkout")) {
            checkedOut = true;
          } else if (usesRepo(s) && !checkedOut) {
            bad.push(s.run ?? s["working-directory"]);
          }
        }
        expect(
          bad,
          `${file} job ${job} uses repo files before actions/checkout`,
        ).toEqual([]);
      });
    }
  }
});

describe("release cadence", () => {
  const w = wf("release-cadence.yml");
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  type Step = any;
  const job = w.jobs.cadence;
  const steps: Step[] = job.steps;

  it("runs every 15 minutes, on dispatch, and after release-please and CI (no check_suite)", () => {
    expect(w.on.schedule).toEqual([{ cron: "*/15 * * * *" }]);
    expect(triggers(w).sort()).toEqual(
      ["schedule", "workflow_dispatch", "workflow_run"].sort(),
    );
    expect(w.on.workflow_run.workflows).toEqual(["release-please", "CI"]);
    expect(w.on.workflow_run.types).toEqual(["completed"]);
    expect(w.concurrency.group).toBe("release-cadence");
  });

  it("checks out the default branch only, without persisting credentials", () => {
    const co = steps.filter((s) =>
      String(s.uses).startsWith("actions/checkout@"),
    );
    expect(co).toHaveLength(1);
    expect(co[0].with["persist-credentials"]).toBe(false);
    expect(co[0].with?.ref).toBeUndefined();
  });

  it("mints a narrowly scoped App token only in a conditional step before arming", () => {
    const app = steps.find((s) => s.id === "app");
    expect(String(app.if)).toContain("steps.plan.outputs.write == 'true'");
    expect(
      Object.fromEntries(
        Object.entries(app.with).filter(([k]) => k.startsWith("permission-")),
      ),
    ).toEqual({
      "permission-pull-requests": "write",
      "permission-contents": "write",
    });
    const i = steps.indexOf(app);
    expect(steps[i + 1].name).toBe("arm");
    expect(String(steps[i + 1].if)).toContain(
      "steps.plan.outputs.write == 'true'",
    );
    const plan = steps.find((s) => s.id === "plan");
    expect(steps.indexOf(plan)).toBeLessThan(i);
    expect(plan.run).toContain("release-cadence.ts plan");
    expect(plan.run).toContain("$GITHUB_OUTPUT");
    expect(JSON.stringify(plan)).not.toContain("steps.app");
  });

  it("uses the App token only in the arm step", () => {
    const withSecrets = steps.filter((s) =>
      /secrets\.RELEASE_APP/.test(JSON.stringify(s)),
    );
    expect(withSecrets).toHaveLength(1);
    expect(String(withSecrets[0].uses)).toMatch(
      /^actions\/create-github-app-token@/,
    );
    expect(withSecrets[0].id).toBe("app");
    const usesToken = steps.filter((s) =>
      JSON.stringify(s).includes("steps.app.outputs.token"),
    );
    expect(usesToken.map((s) => s.name)).toEqual(["arm"]);
    expect(usesToken[0].run).toContain("release-cadence.ts arm");
    // the blocker step runs with GITHUB_TOKEN, and no other secret is read
    const blocker = steps.find((s) => s.name === "blocker");
    expect(blocker.env.GH_TOKEN).toMatch(/^\$\{\{ github\.token \}\}$/);
    expect(JSON.stringify(w)).not.toMatch(
      /secrets\.(?!RELEASE_APP_ID|RELEASE_APP_PRIVATE_KEY)/,
    );
  });

  it("has minimal permissions: none by default, and only issues are writable", () => {
    expect(w.permissions).toEqual({});
    const p = job.permissions as Record<string, string>;
    expect(Object.entries(p).filter(([, v]) => v === "write")).toEqual([
      ["issues", "write"],
    ]);
    expect(Object.keys(p).sort()).toEqual([
      "checks",
      "contents",
      "issues",
      "pull-requests",
      "statuses",
    ]);
    expect(p.contents).toBe("read");
    expect(p["pull-requests"]).toBe("read");
  });

  it("takes no input from the event into its commands", () => {
    for (const s of steps) expect(String(s.run ?? "")).not.toMatch(/\$\{\{/);
  });

  describe("verify-release in release-please.yml", () => {
    const rp = wf("release-please.yml");
    const v = rp.jobs["verify-release"];
    it("runs after both deploys, only when a release was created", () => {
      expect([v.needs].flat()).toEqual(
        expect.arrayContaining(["deploy-prod", "deploy-landing"]),
      );
      expect(String(v.if)).toContain(
        "needs.release-please.outputs.release_created == 'true'",
      );
      expect(String(v.if)).toContain("always()");
    });
    it("can only write issues, and runs the tested script on the new tag", () => {
      expect(v.permissions).toEqual({ contents: "read", issues: "write" });
      // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
      const run = v.steps.find((s: any) =>
        String(s.run ?? "").includes("verify-release.ts"),
      );
      expect(run.run).toContain("--tag");
      expect(JSON.stringify(v)).not.toMatch(/secrets\./);
      expect(v.steps[0].with.ref).toContain("tag_name");
    });
    it("is skipped for pre-release tags", () => {
      expect(String(v.if)).toMatch(
        /!contains\(needs\.release-please\.outputs\.tag_name, '-'\)/,
      );
    });
  });
});

describe("demo instance workflows", () => {
  const dir = join(root, ".github/workflows");
  const CF = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
  // Per file: staging-scoped Cloudflare credentials plus that file's own demo secret; never PROD.
  const ALLOWED: Record<string, string[]> = {
    "ops-demo-install.yml": [...CF, "DEMO_OA_ACCESS_TOKEN"],
    "ops-demo-ops-deploy.yml": [...CF, "DEMO_OA_TOKEN"],
    "demo-reset.yml": ["DEMO_OA_TOKEN"],
    "demo-publish.yml": ["DEMO_OA_TOKEN"],
  };
  const GROUPS: Record<string, string> = {
    "ops-demo-install.yml": "demo-deploy",
    "ops-demo-ops-deploy.yml": "demo-ops-deploy",
    "demo-reset.yml": "demo-reset",
    "demo-publish.yml": "demo-publish",
  };
  // secrets.X, secrets['X'] and secrets["X"]
  const SECRET_RE =
    /secrets(?:\.([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])/g;
  const secretsIn = (v: unknown): string[] => {
    const out: string[] = [];
    const walk = (x: unknown) => {
      if (typeof x === "string")
        for (const m of x.matchAll(SECRET_RE))
          out.push((m[1] ?? m[2]) as string);
      else if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(v);
    return out;
  };
  const demoFiles = readdirSync(dir).filter(
    (n) => /demo/.test(n) && /\.ya?ml$/.test(n),
  );

  it("there is a demo install workflow, named without 'prod'", () => {
    expect(demoFiles).toContain("ops-demo-install.yml");
    for (const f of demoFiles) expect(f).not.toContain("prod");
  });

  it("the secrets matcher sees every syntax", () => {
    expect(
      secretsIn("${{ secrets.A }} ${{ secrets['B'] }} ${{ secrets[\"C\"] }}"),
    ).toEqual(["A", "B", "C"]);
  });

  for (const f of demoFiles) {
    describe(f, () => {
      const w = wf(f);
      it("has an allowlist and a concurrency group", () => {
        expect(ALLOWED[f], `add ${f} to ALLOWED`).toBeDefined();
        expect(GROUPS[f], `add ${f} to GROUPS`).toBeDefined();
      });
      it("uses only its own staging-scoped and demo secrets", () => {
        for (const s of secretsIn(w))
          expect(ALLOWED[f]?.includes(s), s).toBe(true);
      });
      it("serializes on its own group, never cancelling a run", () => {
        const confs = [
          w.concurrency,
          ...Object.values(w.jobs).map(
            (j) => (j as { concurrency?: unknown }).concurrency,
          ),
        ].filter(Boolean) as { group: string; "cancel-in-progress": boolean }[];
        expect(confs.length).toBeGreaterThan(0);
        for (const c of confs) {
          expect(c.group).toBe(GROUPS[f]);
          expect(c["cancel-in-progress"]).toBe(false);
        }
      });
      it("only runs from main", () => {
        for (const [name, j] of Object.entries(w.jobs))
          expect(String((j as { if?: string }).if ?? ""), name).toContain(
            "github.ref == 'refs/heads/main'",
          );
      });
    });
  }

  describe("ops-demo-install.yml", () => {
    const w = wf("ops-demo-install.yml");
    const steps = w.jobs.install.steps;
    it("is dispatch only", () => {
      expect(triggers(w)).toEqual(["workflow_dispatch"]);
    });
    it("runs the demo install through the leak-scanning wrapper with the right credentials", () => {
      const step = steps.find((s: { run?: string }) =>
        String(s.run ?? "").includes('prod-setup.sh "demo-$MODE"'),
      );
      expect(step).toBeDefined();
      // MODE comes only from the dispatch choice and is checked before use.
      expect(step.env.MODE).toBe("${{ inputs.mode }}");
      expect(step.run).toContain('case "$MODE" in install | upgrade) ;;');
      expect(w.on.workflow_dispatch.inputs.mode.options).toEqual([
        "install",
        "upgrade",
      ]);
      expect(step.env.DEMO_PUBLIC_HOME).toBe("${{ vars.DEMO_PUBLIC_HOME }}");
      expect(step.env.CLOUDFLARE_API_TOKEN).toContain(
        "secrets.CLOUDFLARE_API_TOKEN",
      );
      expect(step.env.CLOUDFLARE_ACCOUNT_ID).toContain(
        "secrets.CLOUDFLARE_ACCOUNT_ID",
      );
      expect(step.env.OA_ACCESS_TOKEN).toContain(
        "secrets.DEMO_OA_ACCESS_TOKEN",
      );
      expect(w.env).toMatchObject({
        DEMO_NAME: "open-artifacts-demo",
        DEMO_APP_HOST: "demo.open-artifacts.com",
        DEMO_CONTENT_HOST: "demo-content.open-artifacts.com",
        DEMO_OWNER_EMAIL: "me@leourbina.com",
      });
    });
    it("never calls oa:setup directly", () => {
      expect(JSON.stringify(w)).not.toContain("pnpm -s oa:setup");
    });
    it("revokes setup-ci tokens even on failure", () => {
      const last = steps[steps.length - 1];
      expect(last.if).toBe("always()");
      expect(last.run).toContain("prod-setup.sh demo-cleanup");
    });
  });

  describe("release-please.yml deploy-demo", () => {
    const rp = wf("release-please.yml");
    const job = rp.jobs["deploy-demo"];
    it("runs in parallel with deploy-prod, only on a release and only when DEMO_ENABLED", () => {
      expect([job.needs].flat()).toEqual(["release-please"]);
      expect([rp.jobs["deploy-prod"].needs].flat()).not.toContain(
        "deploy-demo",
      );
      expect(String(job.if)).toContain("vars.DEMO_ENABLED == 'true'");
      expect(String(job.if)).toContain(
        "needs.release-please.outputs.release_created == 'true'",
      );
      expect(String(job.if)).toContain("github.ref == 'refs/heads/main'");
    });
    it("uses !cancelled(), not always(), in the job condition", () => {
      expect(String(job.if)).toContain("!cancelled()");
      expect(String(job.if)).not.toContain("always()");
    });
    it("has read-only contents permission", () => {
      expect(job.permissions).toEqual({ contents: "read" });
    });
    it("has a pre-release guard and gates its steps on it", () => {
      const g = job.steps.find((s: { id?: string }) => s.id === "guard");
      expect(g.run).toContain("isPrerelease");
      for (const s of job.steps)
        if (s !== g)
          expect(String(s.if), s.name ?? s.uses ?? s.run).toContain(
            "steps.guard.outputs.deploy == 'true'",
          );
    });
    it("upgrades through the wrapper with demo credentials and never PROD secrets", () => {
      expect(job.concurrency).toEqual({
        group: "demo-deploy",
        "cancel-in-progress": false,
      });
      const s = JSON.stringify(job);
      expect(s).toContain("prod-setup.sh demo-upgrade");
      expect(s).toContain("prod-setup.sh demo-cleanup");
      expect(s).not.toContain("pnpm -s oa:setup");
      expect(s).toContain("secrets.DEMO_OA_ACCESS_TOKEN");
      expect(s).not.toContain("PROD_CLOUDFLARE_API_TOKEN");
      expect(
        secretsIn(job).every((x) =>
          ALLOWED["ops-demo-install.yml"]?.includes(x),
        ),
      ).toBe(true);
    });
    it("is independent of deploy-prod and deploy-landing", () => {
      expect(JSON.stringify(rp.jobs["deploy-prod"])).not.toContain(
        "deploy-demo",
      );
      expect(JSON.stringify(rp.jobs["deploy-landing"])).not.toContain(
        "deploy-demo",
      );
    });
    it("verify-release waits for it, tolerates it being skipped, and checks the demo only when enabled", () => {
      const v = rp.jobs["verify-release"];
      expect([v.needs].flat()).toEqual(
        expect.arrayContaining([
          "deploy-prod",
          "deploy-landing",
          "deploy-demo",
        ]),
      );
      expect(String(v.if)).toContain("always()");
      // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
      const runs = v.steps.filter((s: any) =>
        String(s.run ?? "").includes("verify-release.ts"),
      );
      // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
      const withDemo = runs.filter((s: any) => s.run.includes("--demo-url"));
      expect(withDemo).toHaveLength(1);
      expect(withDemo[0].run).toContain("https://demo.open-artifacts.com");
      expect(String(withDemo[0].if)).toContain("vars.DEMO_ENABLED == 'true'");
      // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
      const without = runs.find((s: any) => !s.run.includes("--demo-url"));
      expect(String(without.if)).toContain("vars.DEMO_ENABLED != 'true'");
    });
  });

  describe("checkouts in demo workflows", () => {
    const checkouts = (
      jobs: Record<
        string,
        { steps?: { uses?: string; with?: Record<string, unknown> }[] }
      >,
    ) =>
      Object.values(jobs).flatMap((j) =>
        (j.steps ?? []).filter((s) =>
          String(s.uses ?? "").startsWith("actions/checkout"),
        ),
      );
    it("never persist credentials", () => {
      for (const f of demoFiles) {
        const co = checkouts(wf(f).jobs);
        expect(co.length, f).toBeGreaterThan(0);
        for (const s of co)
          expect(s.with?.["persist-credentials"], f).toBe(false);
      }
      const dd = checkouts({ d: wf("release-please.yml").jobs["deploy-demo"] });
      expect(dd.length).toBeGreaterThan(0);
      for (const s of dd) expect(s.with?.["persist-credentials"]).toBe(false);
    });
  });

  describe("prod-setup.sh modes by workflow", () => {
    const modesIn = (f: string) =>
      [...JSON.stringify(wf(f)).matchAll(/prod-setup\.sh ([a-z-]+)/g)].map(
        (m) => m[1] as string,
      );
    const demoJob = (f: string, job: string) =>
      [
        ...JSON.stringify(wf(f).jobs[job]).matchAll(
          /prod-setup\.sh ([a-z-]+)/g,
        ),
      ].map((m) => m[1] as string);
    it("demo workflows call only demo-* modes", () => {
      for (const f of demoFiles)
        for (const m of modesIn(f)) expect(m, f).toMatch(/^demo-/);
      expect(
        demoJob("release-please.yml", "deploy-demo").length,
      ).toBeGreaterThan(0);
      for (const m of demoJob("release-please.yml", "deploy-demo"))
        expect(m).toMatch(/^demo-/);
    });
    it("deploy-prod and ops-prod-* call only prod modes", () => {
      const prod = new Set(["install", "preflight", "upgrade", "cleanup"]);
      for (const m of demoJob("release-please.yml", "deploy-prod"))
        expect(prod.has(m), m).toBe(true);
      for (const f of readdirSync(dir).filter((n) => /^ops-prod-/.test(n)))
        for (const m of modesIn(f)) expect(prod.has(m), `${f} ${m}`).toBe(true);
    });
  });
});
