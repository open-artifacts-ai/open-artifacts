import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script } from "./stubs.ts";

const FAKE = `oa_pat_${"A".repeat(32)}`;
const ok = (step: string) => `{"step":"${step}","status":"ok"}`;

const install = (
  lines: string[],
  pnpmExit = 0,
  mode = "install",
  extra: Record<string, string> = {},
) => {
  const body = `cat <<'EOF_FIXTURE'\n${lines.join("\n")}\nEOF_FIXTURE\nexit ${pnpmExit}`;
  const sb = sandbox({ pnpm: body });
  const summary = join(mkdtempSync(join(tmpdir(), "sum-")), "summary.md");
  const r = sb.run(["bash", script("prod-setup.sh"), mode], {
    env: {
      GITHUB_STEP_SUMMARY: summary,
      PROD_NAME: "open-artifacts-prod",
      PROD_APP_HOST: "app.example.com",
      PROD_CONTENT_HOST: "content.example.com",
      PROD_OWNER_EMAIL: "o@example.com",
      ...extra,
    },
  });
  let sum = "";
  try {
    sum = readFileSync(summary, "utf8");
  } catch {}
  return { ...r, sum, calls: sb.log() };
};

describe("prod-setup.sh", () => {
  it("exits 0 and writes the summary when all steps are ok", () => {
    const r = install([ok("preflight"), ok("deploy"), ok("selftest")]);
    expect(r.code).toBe(0);
    expect(r.sum).toContain("| deploy | ok |");
    expect(r.calls[0]).toContain("--ci");
    expect(r.calls[0]).toContain("--app-host app.example.com");
  });
  it("fails on an action_required line", () => {
    const r = install([
      ok("preflight"),
      `{"step":"dns","status":"action_required"}`,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.sum).toContain("| dns | action_required |");
  });
  it("fails on an error line", () => {
    expect(install([`{"step":"x","status":"error"}`]).code).not.toBe(0);
  });
  it("fails on a token pattern and never echoes it", () => {
    const r = install([ok("a"), `{"step":"b","status":"ok","note":"${FAKE}"}`]);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err + r.sum).not.toContain(FAKE);
    expect(r.out + r.err).toContain("token pattern found in output; aborting");
  });
  it("passes ANALYTICS_TOKEN through env, never argv; aborts if it is echoed", () => {
    const a = "analytics-SECRET-value";
    const env = { ANALYTICS_TOKEN: a };
    const fine = install([ok("secrets")], 0, "install", env);
    expect(fine.code).toBe(0);
    expect(fine.calls.join("\n")).not.toContain(a);
    const r = install(
      [`{"step":"x","status":"ok","m":"${a}"}`],
      0,
      "install",
      env,
    );
    expect(r.code).not.toBe(0);
    expect(r.out + r.err + r.sum).not.toContain(a);
    expect(r.out + r.err).toContain("token pattern found in output; aborting");
  });
  it("aborts on a trimmed or untrimmed echo of ANALYTICS_TOKEN", () => {
    for (const [secret, echoed] of [
      ["abc123\n", "abc123"],
      ["  abc123 ", "abc123"],
      ["  abc123 ", "  abc123 "],
    ] as const) {
      const r = install([`{"step":"x","m":"${echoed}"}`], 0, "install", {
        ANALYTICS_TOKEN: secret,
      });
      expect(r.code, JSON.stringify(secret)).not.toBe(0);
      expect(r.out + r.sum).not.toContain("abc123");
    }
  });
  it("fails when setup exits non-zero", () => {
    expect(install([ok("a")], 1).code).not.toBe(0);
  });
  it("rejects an unknown mode without running setup", () => {
    const r = install([ok("a")], 0, "bogus");
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });

  describe("deploy sequence (as the workflow runs it)", () => {
    // Mirrors the job: later steps skip after a failure, cleanup always runs.
    const sequence = (preflightFails: boolean) => {
      const sb = sandbox({
        pnpm: `case "$*" in *--check*) ${
          preflightFails
            ? `echo '{"step":"resources","status":"todo"}'; exit 2`
            : `echo '{"step":"resources","status":"done"}'`
        };; *) echo '{"step":"x","status":"ok"}';; esac`,
      });
      const env = {
        GITHUB_STEP_SUMMARY: join(sb.dir, "sum.md"),
        PROD_NAME: "open-artifacts-prod",
        PROD_APP_HOST: "app.example.com",
        PROD_CONTENT_HOST: "content.example.com",
        PROD_OWNER_EMAIL: "o@example.com",
      };
      const run = (m: string) =>
        sb.run(["bash", script("prod-setup.sh"), m], { env });
      const pre = run("preflight");
      const up = pre.code === 0 ? run("upgrade") : undefined;
      const clean = run("cleanup");
      return { pre, up, clean, calls: sb.log() };
    };
    it("preflight failure: upgrade is not run, cleanup still runs", () => {
      const r = sequence(true);
      expect(r.pre.code).not.toBe(0);
      expect(r.up).toBeUndefined();
      expect(r.calls[0]).toContain("--check --strict --upgrade");
      expect(r.calls.some((c) => c.includes("--ci --upgrade"))).toBe(false);
      expect(r.calls.at(-1)).toContain("--revoke-ci-tokens");
      expect(r.clean.code).toBe(0);
    });
    it("preflight pass: upgrade runs with --ci, then cleanup", () => {
      const r = sequence(false);
      expect(r.pre.code).toBe(0);
      expect(r.up?.code).toBe(0);
      expect(r.calls[1]).toContain("--ci --upgrade");
      expect(r.calls[1]).not.toContain("--check");
      expect(r.calls[2]).toContain("--ci --revoke-ci-tokens");
    });
    it("install, preflight and upgrade pass --team --yes-paid --email-domain mail.leourbina.com --browser --plan paid; cleanup does not", () => {
      // Prod is Workers Paid, but stateless CI reads the plan as unknown and
      // --json never guesses team: team, email and the plan are explicit.
      const r = sequence(false);
      const SWITCH =
        "--team --yes-paid --email-domain mail.leourbina.com --browser --plan paid";
      for (const c of r.calls.slice(0, 2)) expect(c).toContain(SWITCH);
      expect(install([ok("a")]).calls[0]).toContain(SWITCH);
      expect(r.calls[2]).not.toContain("--team");
      expect(r.calls[2]).not.toContain("--browser");
      for (const c of r.calls) expect(c).not.toContain("--solo");
    });
  });
});

describe("prod-setup.sh demo modes", () => {
  // Record<string, string>: the demo run may add DEMO_PUBLIC_HOME (and a bad value for it).
  const demoEnv: Record<string, string> = {
    DEMO_NAME: "open-artifacts-demo",
    DEMO_APP_HOST: "demo.example.com",
    DEMO_CONTENT_HOST: "demo-content.example.com",
    DEMO_OWNER_EMAIL: "o@example.com",
  };
  const run = (
    mode: string,
    lines: string[],
    env: Record<string, string> = demoEnv,
    exit = 0,
  ) => {
    const body = `cat <<'EOF_FIXTURE'\n${lines.join("\n")}\nEOF_FIXTURE\nexit ${exit}`;
    const sb = sandbox({ pnpm: body });
    const r = sb.run(["bash", script("prod-setup.sh"), mode], {
      env: { GITHUB_STEP_SUMMARY: join(sb.dir, "sum.md"), ...env },
    });
    return { ...r, calls: sb.log() };
  };
  it("demo-install runs the demo flags and hosts", () => {
    const r = run("demo-install", [ok("a")]);
    expect(r.code).toBe(0);
    const c = r.calls[0] as string;
    for (const f of [
      "--ci",
      "--json",
      "--solo",
      "--no-email",
      "--yes-paid",
      "--name open-artifacts-demo",
      "--app-host demo.example.com",
      "--content-host demo-content.example.com",
    ])
      expect(c, f).toContain(f);
    expect(c).not.toContain("--upgrade");
    expect(c).not.toContain("--browser");
  });
  it("demo-upgrade adds --upgrade; demo-cleanup revokes tokens", () => {
    expect(run("demo-upgrade", [ok("a")]).calls[0]).toContain("--upgrade");
    expect(run("demo-cleanup", [ok("a")]).calls[0]).toContain(
      "--revoke-ci-tokens",
    );
  });
  it("a fake PAT in the output fails the step and is never echoed", () => {
    for (const m of ["demo-install", "demo-upgrade", "demo-cleanup"]) {
      const r = run(m, [`{"step":"b","status":"ok","note":"${FAKE}"}`]);
      expect(r.code, m).not.toBe(0);
      expect(r.out + r.err).not.toContain(FAKE);
      expect(r.out + r.err).toContain(
        "token pattern found in output; aborting",
      );
    }
  });
  it("an error status fails the step", () => {
    expect(
      run("demo-install", [`{"step":"x","status":"error"}`]).code,
    ).not.toBe(0);
  });
  it("refuses the production Worker name or host without running setup", () => {
    const bad: Record<string, string>[] = [
      { DEMO_NAME: "open-artifacts-prod" },
      { DEMO_APP_HOST: "artifacts.leourbina.com" },
      { DEMO_NAME: "custom-prod", PROD_NAME: "custom-prod" },
    ];
    for (const b of bad) {
      const r = run("demo-install", [ok("a")], { ...demoEnv, ...b });
      expect(r.code, JSON.stringify(b)).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });
  it("requires the DEMO_* values", () => {
    expect(run("demo-install", [ok("a")], {} as never).code).not.toBe(0);
  });
  describe("DEMO_PUBLIC_HOME", () => {
    const ID = "AbCdEfGhJkMnPqRs";
    it("demo-upgrade and demo-install pass --var PUBLIC_HOME=<id>", () => {
      for (const m of ["demo-upgrade", "demo-install"]) {
        const r = run(m, [ok("a")], { ...demoEnv, DEMO_PUBLIC_HOME: ID });
        expect(r.code, m).toBe(0);
        expect(r.calls[0], m).toContain(`--var PUBLIC_HOME=${ID}`);
      }
    });
    it("passes no --var when unset or empty", () => {
      for (const env of [demoEnv, { ...demoEnv, DEMO_PUBLIC_HOME: "" }]) {
        const r = run("demo-upgrade", [ok("a")], env);
        expect(r.code).toBe(0);
        expect(r.calls[0]).not.toContain("--var");
      }
    });
    it("rejects an invalid id with the error JSON and never calls pnpm", () => {
      for (const bad of [
        "x; rm -rf /",
        "AbCdEfGh",
        "AbCdEfGh JkMnPqR",
        "AbCdEfGhJkMnPqR0",
        `${ID}\n`,
      ]) {
        for (const m of ["demo-install", "demo-upgrade"]) {
          const r = run(m, [ok("a")], { ...demoEnv, DEMO_PUBLIC_HOME: bad });
          expect(r.code, `${m} ${JSON.stringify(bad)}`).toBe(1);
          expect(r.out).toContain(
            '{"step":"demo-vars","status":"error","message":"DEMO_PUBLIC_HOME is not an artifact id"}',
          );
          expect(r.calls).toEqual([]);
        }
      }
    });
    it("prod modes never pass PUBLIC_HOME, even when it is set", () => {
      for (const m of ["install", "preflight", "upgrade", "cleanup"]) {
        const r = install([ok("a")], 0, m, { DEMO_PUBLIC_HOME: ID });
        expect(r.code, m).toBe(0);
        expect(r.calls[0], m).not.toContain("--var");
        expect(r.calls[0], m).not.toContain("PUBLIC_HOME");
      }
    });
  });

  describe("ops-demo-install.yml", () => {
    const wf = readFileSync(
      join(root, ".github/workflows/ops-demo-install.yml"),
      "utf8",
    );
    it("never interpolates inputs.mode into a run: line", () => {
      const lines = wf.split("\n");
      let inRun = false;
      let runIndent = 0;
      for (const l of lines) {
        const indent = l.length - l.trimStart().length;
        const m = /^(\s*)(?:- )?run:/.exec(l);
        if (m) {
          inRun = true;
          runIndent = indent;
          expect(l).not.toMatch(/\$\{\{\s*inputs\./);
        } else if (inRun && l.trim() && indent > runIndent) {
          expect(l).not.toMatch(/\$\{\{\s*inputs\./);
        } else if (l.trim()) inRun = false;
      }
      expect(wf).toMatch(/MODE: \$\{\{ inputs\.mode \}\}/);
      expect(wf).toMatch(
        /DEMO_PUBLIC_HOME: \$\{\{ vars\.DEMO_PUBLIC_HOME \}\}/,
      );
    });
  });
});

describe("prod-setup.sh preflight: not installed vs drifted (#172)", () => {
  const line = (step: string, status: string, message?: string) =>
    JSON.stringify({ step, status, ...(message ? { message } : {}) });
  const NAME = "open-artifacts-prod";
  const resourcesAllMissing = line(
    "resources",
    "todo",
    `todo: missing: D1 ${NAME}, R2 ${NAME}, KV ${NAME}`,
  );
  const neverDeployed = line(
    "deploy",
    "todo",
    `todo: Worker ${NAME} never deployed`,
  );
  const preflight = (lines: string[], exit = 2) => {
    const sb = sandbox({
      pnpm: `cat <<'EOF_FIXTURE'\n${lines.join("\n")}\nEOF_FIXTURE\nexit ${exit}`,
    });
    const summary = join(sb.dir, "summary.md");
    const output = join(sb.dir, "output.txt");
    const r = sb.run(["bash", script("prod-setup.sh"), "preflight"], {
      env: {
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
        PROD_NAME: NAME,
        PROD_APP_HOST: "app.example.com",
        PROD_CONTENT_HOST: "content.example.com",
        PROD_OWNER_EMAIL: "o@example.com",
      },
    });
    const read = (f: string) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return "";
      }
    };
    return { ...r, sum: read(summary), outputs: read(output) };
  };

  it("nothing exists: notice, installed=false, exit 0", () => {
    const r = preflight([
      line("prereqs", "done"),
      resourcesAllMissing,
      line("access", "todo"),
      neverDeployed,
      line("state", "ok"),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      '{"step":"preflight","status":"skipped","message":"not installed: run the Ops - prod install workflow first"}',
    );
    expect(r.out).toContain("::notice::");
    expect(r.sum).toContain("not installed");
    expect(r.outputs).toContain("installed=false");
    expect(r.outputs).not.toContain("installed=true");
  });
  it("partially installed (resources exist, Worker missing): fails, installed=true", () => {
    const r = preflight([
      line("resources", "done"),
      line("access", "todo"),
      neverDeployed,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("not installed");
    expect(r.outputs).toContain("installed=true");
  });
  it("partially installed (Worker exists, a resource missing): fails", () => {
    const r = preflight([
      line("resources", "todo", `todo: missing: KV ${NAME}`),
      line("deploy", "todo", "todo: version drift"),
    ]);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("not installed");
  });
  it("some resources missing and no Worker is partial, not absent: fails", () => {
    const r = preflight([
      line("resources", "todo", `todo: missing: D1 ${NAME}, R2 ${NAME}`),
      neverDeployed,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.outputs).toContain("installed=true");
  });
  it("drifted: fails, installed=true", () => {
    const r = preflight([
      line("resources", "done"),
      line("deploy", "todo", "todo: vars drift"),
    ]);
    expect(r.code).not.toBe(0);
    expect(r.outputs).toContain("installed=true");
  });
  it("fully installed and clean: exit 0, installed=true, no notice", () => {
    const r = preflight([line("resources", "done"), line("state", "ok")], 0);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("not installed");
    expect(r.outputs).toContain("installed=true");
  });
  it("a real error is never read as not installed", () => {
    const r = preflight([
      resourcesAllMissing,
      neverDeployed,
      line("access", "error", "boom"),
    ]);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("not installed");
  });
  it("demo modes ignore the not-installed detection", () => {
    const sb = sandbox({
      pnpm: `cat <<'EOF_FIXTURE'\n${resourcesAllMissing}\n${neverDeployed}\nEOF_FIXTURE\nexit 2`,
    });
    const r = sb.run(["bash", script("prod-setup.sh"), "demo-upgrade"], {
      env: {
        GITHUB_STEP_SUMMARY: join(sb.dir, "s.md"),
        DEMO_NAME: "d",
        DEMO_APP_HOST: "d.example.com",
        DEMO_CONTENT_HOST: "dc.example.com",
        DEMO_OWNER_EMAIL: "o@example.com",
      },
    });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("not installed");
  });
});

describe("prod-setup.sh direct sign-in (PROD_AUTH_*, from repository variables)", () => {
  const AUTH = {
    PROD_AUTH_PROVIDERS: "access,google",
    PROD_AUTH_DOMAINS: "leourbina.com",
    PROD_AUTH_DOMAIN_JOIN: "invite",
    PROD_GOOGLE_CLIENT_ID: "1-x.apps.googleusercontent.com",
  };
  const FLAGS = [
    "--auth-providers=access,google",
    "--auth-domains=leourbina.com",
    "--auth-domain-join=invite",
    "--google-client-id=1-x.apps.googleusercontent.com",
  ];
  it("install, preflight and upgrade pass each set value as one flag", () => {
    for (const m of ["install", "preflight", "upgrade"]) {
      const r = install([ok("a")], 0, m, AUTH);
      expect(r.code, m).toBe(0);
      for (const f of FLAGS) expect(r.calls[0], `${m} ${f}`).toContain(f);
    }
  });
  it("an unset or empty variable passes no flag (setup keeps the live value)", () => {
    const some = install([ok("a")], 0, "upgrade", {
      PROD_AUTH_PROVIDERS: "access",
      PROD_AUTH_DOMAINS: "",
    });
    expect(some.calls[0]).toContain("--auth-providers=access");
    expect(some.calls[0]).not.toContain("--auth-domains");
    expect(some.calls[0]).not.toContain("--auth-domain-join");
    expect(some.calls[0]).not.toContain("--google-client-id");
    const none = install([ok("a")], 0, "upgrade");
    expect(none.calls[0]).not.toMatch(/--auth-|--google-client-id/);
  });
  it("a value is one argv element, never shell", () => {
    const evil = "x; touch /tmp/oa-pwned $(id)";
    const r = install([ok("a")], 0, "upgrade", { PROD_AUTH_DOMAINS: evil });
    expect(r.code).toBe(0);
    expect(r.calls[0]).toContain(`--auth-domains=${evil}`);
  });
  it("cleanup and the demo modes never pass them", () => {
    expect(install([ok("a")], 0, "cleanup", AUTH).calls[0]).not.toMatch(
      /--auth-|--google-client-id/,
    );
    const body = `cat <<'EOF_FIXTURE'\n${ok("a")}\nEOF_FIXTURE\nexit 0`;
    for (const m of ["demo-install", "demo-upgrade", "demo-cleanup"]) {
      const sb = sandbox({ pnpm: body });
      sb.run(["bash", script("prod-setup.sh"), m], {
        env: {
          GITHUB_STEP_SUMMARY: join(sb.dir, "sum.md"),
          DEMO_NAME: "open-artifacts-demo",
          DEMO_APP_HOST: "demo.example.com",
          DEMO_CONTENT_HOST: "demo-content.example.com",
          DEMO_OWNER_EMAIL: "o@example.com",
          ...AUTH,
        },
      });
      expect(sb.log()[0], m).not.toMatch(/--auth-|--google-client-id/);
    }
  });
});

describe("release-please.yml deploy-prod invariants (#172)", () => {
  const yml = readFileSync(
    join(import.meta.dirname, "../../.github/workflows/release-please.yml"),
    "utf8",
  );
  const job = (name: string) => {
    const m = yml.match(
      new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|$)`),
    );
    return m?.[1] ?? "";
  };
  const step = (body: string, run: string) => {
    const parts = body.split(/\n {6}- /);
    return parts.find((p) => p.includes(run)) ?? "";
  };
  const deploy = job("deploy-prod");
  it("the preflight step has an id", () => {
    expect(step(deploy, "prod-setup.sh preflight")).toMatch(/id: preflight/);
  });
  it("upgrade and cleanup are gated on the preflight's installed output", () => {
    for (const mode of ["upgrade", "cleanup"]) {
      const s = step(deploy, `prod-setup.sh ${mode}`);
      expect(s, mode).toContain("steps.preflight.outputs.installed");
      expect(s, mode).toContain("steps.guard.outputs.deploy == 'true'");
    }
  });
  it("verify-release tolerates a skipped deploy-prod on a release (always(), result gate only on the dispatch branch, which alerts on a failed deploy too)", () => {
    const v = job("verify-release");
    expect(v).toContain("deploy-prod");
    expect(v).toMatch(/if: \$\{\{ always\(\)/);
    // The result gate is only inside the workflow_dispatch clause: a guarded
    // dispatch is verified once its prod deploy ran, and a failed one gets the
    // not-live blocker issue.
    expect(v.match(/needs\.deploy-prod\.result/g) ?? []).toHaveLength(2);
    expect(v).toContain(
      "(github.event_name == 'workflow_dispatch' && inputs.tag != '' && !contains(inputs.tag, '-') && (needs.deploy-prod.result == 'success' || needs.deploy-prod.result == 'failure'))",
    );
  });
  it("deploy-prod passes the sign-in repository variables through env, never inline in run:", () => {
    for (const v of [
      "PROD_AUTH_PROVIDERS",
      "PROD_AUTH_DOMAINS",
      "PROD_AUTH_DOMAIN_JOIN",
      "PROD_GOOGLE_CLIENT_ID",
    ])
      expect(deploy, v).toMatch(
        new RegExp(`\\n {6}${v}: \\$\\{\\{ vars\\.${v} \\}\\}\\n`),
      );
    let inRun = false;
    let runIndent = 0;
    for (const l of yml.split("\n")) {
      const indent = l.length - l.trimStart().length;
      if (/^(\s*)(?:- )?run:/.test(l)) {
        inRun = true;
        runIndent = indent;
        expect(l).not.toMatch(/\$\{\{\s*vars\.PROD_/);
      } else if (inRun && l.trim() && indent > runIndent)
        expect(l).not.toMatch(/\$\{\{\s*vars\.PROD_/);
      else if (l.trim()) inRun = false;
    }
  });
  it("every workflow that runs prod-setup.sh install, preflight or upgrade forwards the sign-in variables through env", () => {
    const dir = join(import.meta.dirname, "../../.github/workflows");
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    const users = files.filter((f) =>
      /prod-setup\.sh (install|preflight|upgrade)\b/.test(
        readFileSync(join(dir, f), "utf8"),
      ),
    );
    expect(users.sort()).toEqual([
      "ops-prod-install.yml",
      "release-please.yml",
    ]);
    for (const f of users) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const v of [
        "PROD_AUTH_PROVIDERS",
        "PROD_AUTH_DOMAINS",
        "PROD_AUTH_DOMAIN_JOIN",
        "PROD_GOOGLE_CLIENT_ID",
      ])
        expect(text, `${f} ${v}`).toMatch(
          new RegExp(`\\n +${v}: \\$\\{\\{ vars\\.${v} \\}\\}\\n`),
        );
      expect(text, f).not.toMatch(/run:[^\n]*\$\{\{\s*vars\.PROD_/);
    }
  });
  it("verify-release skips the prod check when prod is not installed", () => {
    const v = job("verify-release");
    expect(v).toContain("needs.deploy-prod.outputs.installed");
  });
});
