// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// prod-release-chain.yml (#1343): a green, dispatched redline-staging run for
// a release tag deploys that tag to the prod platform. The tag comes only from
// the run's display title, which is redline-staging.yml's run-name; main's
// scripts prove it again before deploy-hosted-platform.yml runs as a call.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type Exec,
  fresh,
  isNewer,
  report,
  TITLE_RE,
  tagOf,
} from "./prod-release-chain.ts";
import { root, sandbox, script } from "./stubs.ts";

const read = (p: string) => readFileSync(join(root, p), "utf8");
const text = read(".github/workflows/prod-release-chain.yml");
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const redline: any = parse(read(".github/workflows/redline-staging.yml"));
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const deploy: any = parse(read(".github/workflows/deploy-hosted-platform.yml"));
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const gateSteps: Record<string, any>[] = w.jobs.gate.steps;
const named = (n: string) => {
  const s = gateSteps.find((x) => x.name === n || x.id === n);
  if (!s) throw new Error(`no step ${n}`);
  return s;
};
const REPO = "open-artifacts-ai/open-artifacts";
const TAG = "v0.99.0";
const SHA = "a".repeat(40);
const FULL =
  "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,inventory,provisioning,zones,scheduler";
const ON =
  "${{ vars.PROD_RELEASE_CHAIN == 'on' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'workflow_dispatch' }}";

/** The title redline-staging.yml gives a run for `tag`, from its run-name. */
const titleFor = (tag: string) =>
  String(redline["run-name"]).replace("${{ inputs.tag }}", tag);

/** Runs the tag step as the runner would: TITLE in env, output to a file. */
function tagStep(title: string) {
  const d = mkdtempSync(join(tmpdir(), "chain-tag-"));
  const out = join(d, "output");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-c", named("tag").run], {
    cwd: root,
    env: { PATH: process.env.PATH, TITLE: title, GITHUB_OUTPUT: out },
    encoding: "utf8",
  });
  return { status: r.status, output: readFileSync(out, "utf8") };
}

describe("prod-release-chain.yml", () => {
  it("runs only on a completed redline-staging run, green, dispatched, with the switch on", () => {
    expect(w.on).toEqual({
      workflow_run: { workflows: ["redline-staging"], types: ["completed"] },
    });
    // The name it listens for is redline-staging.yml's own.
    expect(redline.name).toBe("redline-staging");
    expect(w.jobs.gate.if).toBe(ON);
    // The report reports only a chain that was meant to run.
    expect(w.jobs.report.if).toBe(ON.replace("${{ ", "${{ always() && "));
    expect(w.concurrency).toEqual({
      group: "prod-release-chain",
      "cancel-in-progress": false,
    });
    expect(Object.keys(w.jobs)).toEqual(["gate", "deploy", "report"]);
  });

  it("least privilege: nothing at the top, each job only what it needs", () => {
    expect(w.permissions).toEqual({});
    expect(w.jobs.gate.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    // The called workflow's own: its gates read runs, and its token read-back
    // and break-glass record open issues.
    expect(w.jobs.deploy.permissions).toEqual({
      contents: "read",
      actions: "read",
      issues: "write",
    });
    expect(deploy.permissions).toEqual(w.jobs.deploy.permissions);
    expect(w.jobs.report.permissions).toEqual({
      contents: "read",
      issues: "write",
    });
    expect(text).not.toMatch(/id-token|write-all|read-all|secrets: inherit/);
  });

  it("pins every action by SHA and keeps no git credentials", () => {
    for (const l of text.split("\n").filter((l) => /^\s*- uses: /.test(l)))
      expect(l).toMatch(/@[0-9a-f]{40} # v\d/);
    for (const job of [w.jobs.gate, w.jobs.report])
      for (const s of job.steps) {
        if (!s.uses) continue;
        expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
        if (String(s.uses).startsWith("actions/checkout@")) {
          expect(s.with.ref).toBe("${{ github.sha }}");
          expect(s.with["persist-credentials"]).toBe(false);
        }
      }
  });

  it("no expression in any run line: every value reaches a script through env", () => {
    for (const job of [w.jobs.gate, w.jobs.report])
      for (const s of job.steps)
        if (s.run) expect(String(s.run), s.name).not.toContain("${{");
    // The event's untrusted fields are only ever env values.
    const tag = named("tag");
    expect(tag.env).toEqual({
      TITLE: "${{ github.event.workflow_run.display_title }}",
    });
    expect(named("This event is the newest green run for the tag").env).toEqual(
      {
        TAG: "${{ steps.tag.outputs.tag }}",
        HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
        GH_TOKEN: "${{ github.token }}",
      },
    );
  });

  it("the tag parse matches redline-staging's run-name contract", () => {
    // The run-name the gate and staging-first-gate.sh read.
    expect(redline["run-name"]).toBe("redline-staging ${{ inputs.tag }}");
    expect(read("scripts/ci/staging-first-gate.sh")).toContain(
      '--arg title "redline-staging $tag"',
    );
    for (const tag of [TAG, "v1.2.3", "v10.20.30", "v0.0.1"]) {
      expect(tagOf(titleFor(tag))).toBe(tag);
      const r = tagStep(titleFor(tag));
      expect(r.status, tag).toBe(0);
      expect(r.output).toBe(`tag=${tag}\n`);
    }
    // Anything else stops the gate before a script sees it.
    for (const bad of [
      "redline-staging",
      "redline-staging ",
      "redline-staging v1.2",
      "redline-staging v1.2.3-rc.1",
      "redline-staging 1.2.3",
      "redline-staging v1.2.3 ",
      " redline-staging v1.2.3",
      "redline-staging  v1.2.3",
      "redline-staging v1.2.3\nredline-staging v9.9.9",
      "redline-staging v1.2.3\ntag=v9.9.9",
      "redline-staging v1.2.3;id",
      "redline-staging $(id)",
      "redline-nightly v1.2.3",
      "deploy-hosted-platform prod v1.2.3",
      "redline-staging v1234567.0.0",
    ]) {
      expect(TITLE_RE.test(bad), JSON.stringify(bad)).toBe(false);
      expect(() => tagOf(bad)).toThrow();
      const r = tagStep(bad);
      expect(r.status, JSON.stringify(bad)).not.toBe(0);
      expect(r.output, JSON.stringify(bad)).toBe("");
    }
  });

  it("the gate: main, then main's scripts, then the gates in order, each given the parsed tag", () => {
    expect(w.jobs.gate.environment).toBe("hosted-prod-deploy");
    expect(w.jobs.gate.outputs).toEqual({
      tag: "${{ steps.tag.outputs.tag }}",
      go: "${{ steps.fresh.outputs.go == 'true' && steps.newer.outputs.go == 'true' }}",
    });
    expect(gateSteps[0]).toMatchObject({
      name: "On main",
      env: { REF: "${{ github.ref }}" },
    });
    expect(gateSteps[0]?.run).toContain('[ "$REF" = refs/heads/main ]');
    expect(gateSteps.map((s) => s.name ?? s.uses)).toEqual([
      "On main",
      gateSteps[1]?.uses,
      gateSteps[2]?.uses,
      "The tag, from the red-line run's name",
      "Staging passed this tag",
      "Staging's smoke is green at or after this tag",
      "The tag passed every earlier check",
      "This event is the newest green run for the tag",
      "Load the hosted constants",
      "The tag is newer than prod's",
    ]);
    expect(gateSteps[1]?.with).toEqual({
      ref: "${{ github.sha }}",
      "sparse-checkout": "scripts/ci\n.github/hosted\n",
      "persist-credentials": false,
    });
    const tagged = { TAG: "${{ steps.tag.outputs.tag }}" };
    expect(named("Staging passed this tag")).toMatchObject({
      env: { ...tagged, GH_TOKEN: "${{ github.token }}" },
      run: 'bash scripts/ci/staging-first-gate.sh "$TAG"',
    });
    expect(
      named("Staging's smoke is green at or after this tag"),
    ).toMatchObject({
      env: { ...tagged, GH_TOKEN: "${{ github.token }}" },
      run: 'bash scripts/ci/staging-smoke-gate.sh "$TAG"',
    });
    expect(named("The tag passed every earlier check")).toMatchObject({
      env: { ...tagged, GH_TOKEN: "${{ github.token }}" },
      run: 'bash scripts/ci/tag-passed-checks.sh prod "$TAG"',
    });
    const fr = named("fresh");
    expect(fr.name).toBe("This event is the newest green run for the tag");
    expect(fr.run).toContain(
      'go="$(node --experimental-strip-types scripts/ci/prod-release-chain.ts fresh --repo "$GITHUB_REPOSITORY" --tag "$TAG" --head-sha "$HEAD_SHA")"',
    );
    // A stale event skips what follows, neutrally.
    expect(named("Load the hosted constants")).toMatchObject({
      if: "steps.fresh.outputs.go == 'true'",
      run: "bash scripts/ci/hosted-constants.sh prod .github/hosted > /dev/null",
    });
    const newer = named("newer");
    expect(newer.name).toBe("The tag is newer than prod's");
    expect(newer.if).toBe("steps.fresh.outputs.go == 'true'");
    expect(newer.env).toEqual({
      ...tagged,
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
    expect(newer.run).toContain(
      'current="$(bash scripts/ci/worker-tag.sh prod scheduler)"',
    );
    expect(newer.run).toContain(
      'go="$(node --experimental-strip-types scripts/ci/prod-release-chain.ts newer --tag "$TAG" --current "$current")"',
    );
    // Only that step sees a secret.
    expect(
      gateSteps.filter((s) => JSON.stringify(s).includes("secrets.")),
    ).toEqual([newer]);
    // The scripts it calls take exactly these arguments.
    const usage = (f: string) =>
      /^# Usage: (.*)$/m.exec(read(`scripts/ci/${f}`))?.[1] ?? "";
    expect(usage("staging-first-gate.sh")).toBe(
      "scripts/ci/staging-first-gate.sh vX.Y.Z",
    );
    expect(usage("staging-smoke-gate.sh")).toBe(
      "scripts/ci/staging-smoke-gate.sh vX.Y.Z",
    );
    expect(usage("tag-passed-checks.sh")).toBe(
      "scripts/ci/tag-passed-checks.sh staging|prod vX.Y.Z",
    );
  });

  it("deploys through deploy-hosted-platform.yml: prod, every target, after the gate", () => {
    const d = w.jobs.deploy;
    expect(d.needs).toBe("gate");
    expect(d.uses).toBe("./.github/workflows/deploy-hosted-platform.yml");
    expect(d.with).toEqual({
      env: "prod",
      tag: "${{ needs.gate.outputs.tag }}",
      targets: FULL,
      reason: "",
      verify_only: false,
      require_newer: true,
    });
    // Only when the gate says go: a skip deploys nothing.
    expect(d.if).toBe("needs.gate.outputs.go == 'true'");
    // Secrets are passed by name (never `inherit`); the full rule is the
    // "every secret the deploy reads" test below.
    expect(d.secrets).not.toBe("inherit");
    // The full list is the deploy's own: its read-back and no-break-glass
    // `if:`s compare against it.
    expect(deploy.on.workflow_dispatch.inputs.targets.default).toBe(FULL);
    expect(deploy.on.workflow_call.inputs.targets.default).toBe(FULL);
    const steps = deploy.jobs.deploy.steps as Record<string, string>[];
    const ifOf = (n: string) => steps.find((s) => s.name === n)?.if;
    expect(ifOf("Every platform Worker runs the tag")).toBe(
      `\${{ inputs.targets == '${FULL}' }}`,
    );
    expect(ifOf("Record the break-glass deploy")).toBe(
      `\${{ !inputs.verify_only && inputs.targets != '${FULL}' }}`,
    );
    // Its Environment and concurrency group resolve from inputs.env.
    expect(deploy.jobs.deploy.environment).toBe(
      "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
    );
    expect(deploy.concurrency.group).toBe("hosted-platform-${{ inputs.env }}");
    // No group of the chain's own on the call: the same group twice deadlocks.
    expect(d.concurrency).toBeUndefined();
  });

  it("reports every chain run it was meant to run, the gate's failure included", () => {
    const r = w.jobs.report;
    expect(r.needs).toEqual(["gate", "deploy"]);
    const step = r.steps.find(
      (s: { name?: string }) => s.name === "Keep the blocker issue in step",
    );
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      TAG: "${{ needs.gate.outputs.tag }}",
      RESULT:
        "${{ needs.gate.result == 'success' && needs.deploy.result || needs.gate.result }}",
      RUN: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    });
    expect(step.run).toBe(
      'node --experimental-strip-types scripts/ci/prod-release-chain.ts report --repo "$GITHUB_REPOSITORY" --tag "$TAG" --result "$RESULT" --run "$RUN"',
    );
  });
});

type R = {
  id: number;
  status?: string;
  conclusion?: string | null;
  display_title?: string;
  head_branch?: string;
  head_sha?: string;
  event?: string;
  created_at?: string;
  head_repository?: { full_name: string };
};
const run = (over: R): R => ({
  status: "completed",
  conclusion: "success",
  display_title: `redline-staging ${TAG}`,
  head_branch: "main",
  head_sha: SHA,
  event: "workflow_dispatch",
  created_at: "2026-11-03T10:00:00Z",
  head_repository: { full_name: REPO },
  ...over,
});
const runsExec =
  (runs: R[] | "fail" | "junk", calls: string[][] = []): Exec =>
  (_c, args) => {
    calls.push(args);
    if (runs === "fail") return { code: 1, stdout: "", stderr: "HTTP 502" };
    if (runs === "junk") return { code: 0, stdout: "{}", stderr: "" };
    return {
      code: 0,
      stdout: JSON.stringify({ workflow_runs: runs }),
      stderr: "",
    };
  };

describe("fresh: this event is the newest green run for the tag", () => {
  const go = (runs: R[] | "fail" | "junk", headSha = SHA, tag = TAG) =>
    fresh({ exec: runsExec(runs), repo: REPO, tag, headSha });

  it("passes when the newest matching run has the event's head sha", () => {
    const calls: string[][] = [];
    expect(
      fresh({
        exec: runsExec([run({ id: 5 })], calls),
        repo: REPO,
        tag: TAG,
        headSha: SHA,
      }),
    ).toEqual({ run: 5, go: true });
    expect(calls[0]).toEqual([
      "api",
      "-X",
      "GET",
      `repos/${REPO}/actions/workflows/redline-staging.yml/runs?branch=main&status=success&event=workflow_dispatch&per_page=100`,
    ]);
  });

  it("a stale event: a newer green run for the tag has another sha", () => {
    const newer = "b".repeat(40);
    const runs = [
      run({ id: 9, head_sha: newer, created_at: "2026-11-03T12:00:00Z" }),
      run({ id: 5 }),
    ];
    // Stale: no error, a neutral skip.
    expect(go(runs)).toEqual({ run: 9, go: false });
    expect(go(runs, newer)).toEqual({ run: 9, go: true });
  });

  it("counts only what staging-first-gate.sh counts", () => {
    const other = "c".repeat(40);
    // Each is newer than the real one and has another sha, but doesn't count.
    const late = "2026-11-03T12:00:00Z";
    for (const over of [
      { conclusion: "failure" },
      { status: "in_progress" },
      { head_branch: "feature" },
      { event: "workflow_call" },
      { event: "schedule" },
      { head_repository: { full_name: "fork/open-artifacts" } },
      { display_title: "redline-staging v0.98.0" },
      { display_title: `redline-staging ${TAG} ` },
    ] as Partial<R>[])
      expect(
        go([
          run({ id: 9, head_sha: other, created_at: late, ...over }),
          run({ id: 5 }),
        ]),
        JSON.stringify(over),
      ).toEqual({ run: 5, go: true });
  });

  it("fails closed: no run, an API error, an unparsable answer, a bad sha or tag", () => {
    expect(() => go([])).toThrow(/no green/);
    expect(() => go("fail")).toThrow(/HTTP 502/);
    expect(() => go("junk")).toThrow(/unparsable/);
    expect(() => go([run({ id: 5 })], "")).toThrow(/head sha/);
    expect(() => go([run({ id: 5 })], "A".repeat(40))).toThrow(/head sha/);
    expect(() => go([run({ id: 5 })], SHA, "0.99.0")).toThrow(/release tag/);
  });
});

describe("newer: the tag is above what prod's scheduler runs", () => {
  it("compares numerically, part by part", () => {
    expect(isNewer("v0.100.0", "v0.99.9")).toBe(true);
    expect(isNewer("v1.0.0", "v0.999.999")).toBe(true);
    expect(isNewer("v0.99.1", "v0.99.0")).toBe(true);
    expect(isNewer("v0.99.0", "v0.99.0")).toBe(false);
    expect(isNewer("v0.98.9", "v0.99.0")).toBe(false);
    expect(isNewer("v0.9.0", "v0.10.0")).toBe(false);
  });

  it("a malformed current or tag throws, so the gate fails", () => {
    for (const [t, c] of [
      [TAG, ""],
      [TAG, "0.98.0"],
      [TAG, "v0.98.0-rc.1"],
      ["", "v0.98.0"],
    ] as const)
      expect(() => isNewer(t, c), `${t} ${c}`).toThrow();
    const cli = (mode: string, current: string) => {
      const r = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          script("prod-release-chain.ts"),
          mode,
          "--tag",
          TAG,
          "--current",
          current,
        ],
        { encoding: "utf8" },
      );
      return { status: r.status, out: r.stdout };
    };
    // The gate: not newer is a neutral skip (go=false, exit 0).
    expect(cli("newer", "v0.98.0")).toEqual({ status: 0, out: "go=true\n" });
    expect(cli("newer", TAG)).toEqual({ status: 0, out: "go=false\n" });
    expect(cli("newer", "v1.0.0")).toEqual({ status: 0, out: "go=false\n" });
    expect(cli("newer", "").status).not.toBe(0);
    // The deploy's re-check: not newer fails.
    expect(cli("require-newer", "v0.98.0")).toEqual({ status: 0, out: "" });
    expect(cli("require-newer", TAG).status).not.toBe(0);
    expect(cli("require-newer", "v1.0.0").status).not.toBe(0);
    expect(cli("require-newer", "").status).not.toBe(0);
  });
});

describe("report: one blocker issue while red", () => {
  const world = (open: { number: number; title: string }[]) => {
    const calls: string[][] = [];
    const exec: Exec = (_c, args) => {
      calls.push(args);
      const out = (v: unknown) => ({
        code: 0,
        stdout: JSON.stringify(v),
        stderr: "",
      });
      if (args[0] === "issue" && args[1] === "list") return out(open);
      if (args[0] === "label" && args[1] === "list")
        return out([{ name: "blocker" }]);
      return { code: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  };
  const RUN = "https://github.com/x/actions/runs/1";

  it("red opens one, then refreshes it; the nightly's issue is not its own", () => {
    const a = world([{ number: 3, title: "Nightly red-line failed: v0.98.0" }]);
    expect(
      report({
        exec: a.exec,
        repo: REPO,
        tag: TAG,
        result: "failure",
        run: RUN,
      }),
    ).toEqual({ action: "opened" });
    const create = a.calls.find((c) => c[1] === "create");
    expect(create).toContain(`Prod release chain failed: ${TAG}`);
    expect(create).toContain("blocker");
    const b = world([
      { number: 4, title: "Prod release chain failed: v0.98.0" },
    ]);
    expect(
      report({
        exec: b.exec,
        repo: REPO,
        tag: TAG,
        result: "failure",
        run: RUN,
      }),
    ).toEqual({ action: "refreshed", issue: 4 });
  });

  it("a neutral skip (stale event, a release prod has) neither opens, refreshes nor closes it", () => {
    const a = world([
      { number: 4, title: "Prod release chain failed: v0.98.0" },
    ]);
    expect(
      report({
        exec: a.exec,
        repo: REPO,
        tag: TAG,
        result: "skipped",
        run: RUN,
      }),
    ).toEqual({ action: "none" });
    expect(a.calls).toEqual([]);
  });

  it("green closes it", () => {
    const a = world([
      { number: 4, title: "Prod release chain failed: v0.98.0" },
    ]);
    expect(
      report({
        exec: a.exec,
        repo: REPO,
        tag: TAG,
        result: "success",
        run: RUN,
      }),
    ).toEqual({ action: "closed", issues: [4] });
    expect(
      report({
        exec: world([]).exec,
        repo: REPO,
        tag: TAG,
        result: "success",
        run: RUN,
      }),
    ).toEqual({ action: "none" });
  });

  it("a failed gate with no tag still opens one, naming no tag", () => {
    const a = world([]);
    report({ exec: a.exec, repo: REPO, tag: "", result: "failure", run: RUN });
    expect(a.calls.find((c) => c[1] === "create")).toContain(
      "Prod release chain failed: no release tag",
    );
  });
});

// worker-tag.sh: curl is a stub; the token reaches it on stdin only.
describe("worker-tag.sh", () => {
  const TOK = "cfut_TOKEN_never_printed_0123456789";
  const ACCT = "26ac346086d4405f7a976d48747a2a75";
  const VID = "11111111-0000-4000-8000-111111111111";
  const curl = `cfg="$(cat)"
case "$cfg" in *"Bearer $TOK_EXPECT"*) ;; *) echo '{"success":false,"errors":[{"message":"bad token"}]}'; exit 0 ;; esac
url="\${@: -1}"; path="\${url#https://api.cloudflare.com/client/v4/accounts/$STUB_ACCT/workers/scripts/}"
case "$path" in
  */deployments) f="$STATE/deployments" ;;
  */versions/*) f="$STATE/version" ;;
  *) echo '{"success":false}'; exit 0 ;;
esac
echo "$path" >> "$STATE/paths"
[ -f "$f" ] || { echo '{"success":false,"errors":[{"code":10007}]}'; exit 0; }
cat "$f"`;
  const ok = (result: unknown) => JSON.stringify({ success: true, result });
  const deployments = (versions: unknown[]) =>
    ok({
      deployments: [
        {
          created_on: "2026-10-01T00:00:00Z",
          versions: [{ version_id: VID, percentage: 100 }],
        },
        { created_on: "2026-11-01T00:00:00Z", versions },
      ],
    });
  const go = (
    fx: { deployments?: string; version?: string },
    args = ["prod", "scheduler"],
  ) => {
    const sb = sandbox({ curl });
    const state = join(sb.dir, "state");
    mkdirSync(state);
    if (fx.deployments)
      writeFileSync(join(state, "deployments"), fx.deployments);
    if (fx.version) writeFileSync(join(state, "version"), fx.version);
    const r = sb.run(["bash", script("worker-tag.sh"), ...args], {
      env: {
        CLOUDFLARE_API_TOKEN: TOK,
        CLOUDFLARE_ACCOUNT_ID: ACCT,
        TOK_EXPECT: TOK,
        STUB_ACCT: ACCT,
        STATE: state,
      },
    });
    let paths = "";
    try {
      paths = readFileSync(join(state, "paths"), "utf8");
    } catch {}
    return { ...r, log: sb.log().join("\n"), paths };
  };
  const one = deployments([{ version_id: VID, percentage: 100 }]);
  const tagged = (tag: unknown) =>
    ok({ id: VID, annotations: { "workers/tag": tag } });

  it("prints the release the newest deployment serves, reading the env's Worker", () => {
    const r = go({ deployments: one, version: tagged("v0.98.0") });
    expect(r.code).toBe(0);
    expect(r.out).toBe("v0.98.0\n");
    expect(r.paths).toBe(
      `oa-p-scheduler/deployments\noa-p-scheduler/versions/${VID}\n`,
    );
    // The token never reaches argv.
    expect(r.log).not.toContain(TOK);
    expect(r.out + r.err).not.toContain(TOK);
  });

  it("fails closed, printing nothing: split, untagged, not a release, no deployment, API error", () => {
    const cases = {
      split: {
        deployments: deployments([
          { version_id: VID, percentage: 50 },
          { version_id: VID, percentage: 50 },
        ]),
        version: tagged("v0.98.0"),
      },
      untagged: { deployments: one, version: ok({ id: VID, annotations: {} }) },
      other: { deployments: one, version: tagged("hotfix") },
      rc: { deployments: one, version: tagged("v0.98.0-rc.1") },
      none: {
        deployments: ok({ deployments: [] }),
        version: tagged("v0.98.0"),
      },
      api: { version: tagged("v0.98.0") },
      noVersion: { deployments: one },
    };
    for (const [k, fx] of Object.entries(cases)) {
      const r = go(fx);
      expect(r.code, k).toBe(1);
      expect(r.out, k).toBe("");
    }
  });

  it("refuses an unknown env or app before any call", () => {
    for (const args of [
      ["dev", "scheduler"],
      ["prod", "zones"],
      ["prod", "../x"],
      ["prod"],
    ]) {
      const r = go({ deployments: one, version: tagged("v0.98.0") }, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.paths).toBe("");
    }
  });
});

// The skip steps, run as the runner would: node stubbed to print go=...
describe("the gate's neutral skips", () => {
  const runStep = (name: string, go: string) => {
    const d = mkdtempSync(join(tmpdir(), "chain-skip-"));
    const bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), `#!/usr/bin/env bash\necho ${go}\n`, {
      mode: 0o755,
    });
    const out = join(d, "output");
    writeFileSync(out, "");
    const run = String(named(name).run).replace(
      "bash scripts/ci/worker-tag.sh prod scheduler",
      "echo v0.98.0",
    );
    const r = spawnSync("bash", ["-c", run], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        TAG,
        HEAD_SHA: SHA,
        GITHUB_REPOSITORY: REPO,
      },
      encoding: "utf8",
    });
    return {
      status: r.status,
      out: r.stdout,
      output: readFileSync(out, "utf8"),
    };
  };
  for (const step of ["fresh", "newer"]) {
    it(`${step}: go=false is green with a notice, and the output says so`, () => {
      const r = runStep(step, "go=false");
      expect(r.status).toBe(0);
      expect(r.output).toBe("go=false\n");
      expect(r.out).toContain("::notice title=Release chain skipped::");
      const ok = runStep(step, "go=true");
      expect(ok.status).toBe(0);
      expect(ok.output).toBe("go=true\n");
      expect(ok.out).not.toContain("::notice");
    });
  }
  it("the report sees a skip as 'skipped': the deploy job doesn't run", () => {
    const step = w.jobs.report.steps.find(
      (s: { name?: string }) => s.name === "Keep the blocker issue in step",
    );
    // gate success and go false: deploy is skipped, so RESULT is "skipped".
    expect(step.env.RESULT).toBe(
      "${{ needs.gate.result == 'success' && needs.deploy.result || needs.gate.result }}",
    );
    expect(w.jobs.deploy.if).toBe("needs.gate.outputs.go == 'true'");
  });

  // Run 42109047045: a declared workflow_call secret the caller does not pass
  // resolves to an empty string, even when the called job's Environment
  // (hosted-prod-deploy) has it. GitHub: "The caller workflow must still pass
  // the secret ... You can pass a secret by name even if it only exists in the
  // environment", and the Environment's value wins inside the job.
  // https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
  it("passes every secret the deploy job reads, by name, so none resolves empty", () => {
    const read_ = new Set(
      JSON.stringify(deploy.jobs.deploy.steps).match(/secrets\.[A-Z_]+/g),
    );
    const names = [...read_].map((x) => x.slice("secrets.".length)).sort();
    expect(names.length).toBeGreaterThan(0);
    const passed = w.jobs.deploy.secrets as Record<string, string>;
    const missing = names.filter((n) => passed[n] !== `\${{ secrets.${n} }}`);
    expect(
      missing,
      "deploy reads these but the chain does not pass them",
    ).toEqual([]);
    expect(Object.keys(passed).sort()).toEqual(names);
    expect(Object.keys(deploy.on.workflow_call.secrets).sort()).toEqual(names);
  });
});
