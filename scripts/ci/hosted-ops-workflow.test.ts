// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// hosted-ops.yml (OPS-B): one oa:hosted operation by hand, in the env's
// reviewer-gated Environment, inputs only through env and the ci-args
// validator, secrets only in the step that writes the 0600 token files, and
// an always() sweep of the ephemeral CI owner token.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root, sandbox } from "./stubs.ts";

const text = readFileSync(
  join(root, ".github/workflows/hosted-ops.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
const job = w.jobs.op;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const steps: Record<string, any>[] = job.steps;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const named = (n: string): Record<string, any> => {
  const s = steps.find((x) => x.name === n);
  if (!s) throw new Error(`no step ${n}`);
  return s;
};
const ENVIRONMENT =
  "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}";

describe("hosted-ops.yml", () => {
  it("runs only on dispatch, read-only, one at a time per install, in the gated Environment", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    const inputs = w.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(
      ["args", "confirm", "env", "install", "op", "tag"].sort(),
    );
    expect(inputs.env).toMatchObject({
      type: "choice",
      options: ["staging", "prod"],
      required: true,
    });
    expect([...inputs.op.options].sort()).toEqual(
      [
        "create",
        "upgrade",
        "rollback",
        "update-vars",
        "status",
        "delete",
        "release-lease",
        "turnstile-init",
        "publish-release",
        "publish-floor",
      ].sort(),
    );
    expect(w.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBe(ENVIRONMENT);
    expect(w.concurrency).toEqual({
      group: "hosted-ops-${{ inputs.env }}-${{ inputs.install || inputs.env }}",
      "cancel-in-progress": false,
    });
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(45);
  });

  it("pins every action by SHA and keeps no git credentials", () => {
    for (const l of text.split("\n").filter((l) => /^\s*- uses: /.test(l)))
      expect(l).toMatch(/@[0-9a-f]{40} # v\d/);
    for (const s of steps.filter((s) => s.uses)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
      if (String(s.uses).startsWith("actions/checkout@"))
        expect(s.with["persist-credentials"]).toBe(false);
    }
  });

  it("prod runs only from main, checked first; the CLI's guard gets the same Environment expression", () => {
    const s = named("Prod runs only from main");
    expect(steps.indexOf(s)).toBe(0);
    expect(s.if).toBe("${{ inputs.env == 'prod' }}");
    expect(s.run).toBe('test "$REF" = refs/heads/main');
    expect(s.env).toEqual({ REF: "${{ github.ref }}" });
    for (const n of ["Run the operation", "Sweep the CI owner token"])
      expect(named(n).env.OA_HOSTED_ENVIRONMENT).toBe(ENVIRONMENT);
  });

  it("no input or expression is ever in shell text: inputs go through env only", () => {
    for (const s of steps)
      if (typeof s.run === "string") expect(s.run, s.name).not.toContain("${{");
    const env = named("Check the inputs").env;
    expect(env).toEqual({
      OPS_ENV: "${{ inputs.env }}",
      OPS_OP: "${{ inputs.op }}",
      OPS_INSTALL: "${{ inputs.install }}",
      OPS_TAG: "${{ inputs.tag }}",
      OPS_ARGS: "${{ inputs.args }}",
      OPS_CONFIRM: "${{ inputs.confirm }}",
      OPS_FLOOR_FILE: "${{ runner.temp }}/hosted-ops-floor.sig.json",
    });
    expect(named("Check the inputs").run).toContain(
      'node scripts/hosted/src/ci-args.ts > "$RUNNER_TEMP/hosted-ops-argv.json"',
    );
    expect(steps.indexOf(named("Check the inputs"))).toBeLessThan(
      steps.indexOf(named("Write the token files")),
    );
  });

  it("only the token-file step sees secrets, exactly PROVISION_TOKEN and (publish ops only) R2_TOKEN", () => {
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets.map((s) => s.name)).toEqual(["Write the token files"]);
    const s = named("Write the token files");
    expect(s.env).toEqual({
      PROVISION_TOKEN: "${{ secrets.PROVISION_TOKEN }}",
      R2_TOKEN:
        "${{ (inputs.op == 'publish-release' || inputs.op == 'publish-floor') && secrets.R2_TOKEN || '' }}",
    });
    expect(s.run).toMatch(/^set \+x\n/);
    expect(s.run).toContain("umask 077");
    expect(JSON.stringify(w)).not.toContain("DEPLOY_TOKEN");
    // The CLI step gets file paths, never a secret value.
    const run = named("Run the operation").env;
    expect(run.OA_HOSTED_TOKEN_FILE).toBe(
      "${{ runner.temp }}/hosted-ops-secrets/token",
    );
    expect(run.GH_TOKEN).toBe(
      "${{ inputs.op == 'publish-release' && github.token || '' }}",
    );
  });

  it("always(): the sweep for the lifecycle ops, then the files are removed, then the summary", () => {
    const sweep = named("Sweep the CI owner token");
    expect(sweep.if).toBe(
      `\${{ always() && contains(fromJSON('["create","upgrade","rollback","update-vars"]'), inputs.op) }}`,
    );
    expect(sweep.run).toContain(
      'pnpm -s oa:hosted ci-token-sweep --env "$OPS_ENV" --install "$id" --run "$GITHUB_RUN_ID"',
    );
    const rm = named("Remove the token files");
    expect(rm.if).toBe("${{ always() }}");
    expect(rm.run).toContain('"$RUNNER_TEMP/hosted-ops-secrets"');
    expect(named("Summary").if).toBe("${{ always() }}");
    const i = (n: string) => steps.indexOf(named(n));
    expect(i("Run the operation")).toBeLessThan(i("Sweep the CI owner token"));
    expect(i("Sweep the CI owner token")).toBeLessThan(
      i("Remove the token files"),
    );
    expect(i("Remove the token files")).toBeLessThan(i("Summary"));
  });
});

describe("the steps' shell, run", () => {
  /** A RUNNER_TEMP, and a pnpm stub that logs each argv entry on its own line. */
  const box = () => {
    const sb = sandbox({
      pnpm: 'for a in "$@"; do printf "ARG<%s>\\n" "$a" >> "$STUB_LOG"; done\necho \'{"step":"note","status":"ok"}\'',
    });
    const temp = join(sb.dir, "runner-temp");
    mkdirSync(temp);
    return { sb, temp };
  };
  const bash = (
    sb: ReturnType<typeof sandbox>,
    run: string,
    env: Record<string, string>,
  ) => sb.run(["bash", "-c", run], { cwd: root, env });

  it("the inputs check and the run step pass every value as one inert argv entry", () => {
    const { sb, temp } = box();
    const reason = "$(touch /tmp/oa-pwned) `id`; echo x && y | z 'q\" \\";
    const check = bash(sb, named("Check the inputs").run, {
      RUNNER_TEMP: temp,
      OPS_ENV: "staging",
      OPS_OP: "delete",
      OPS_INSTALL: "iabcdefghijk",
      OPS_TAG: "",
      OPS_ARGS: JSON.stringify({ skipDirectoryRevoke: reason }),
      OPS_CONFIRM: "iabcdefghijk",
      OPS_FLOOR_FILE: join(temp, "floor.json"),
    });
    expect(check.err).toBe("");
    expect(check.code).toBe(0);
    const r = bash(sb, named("Run the operation").run, { RUNNER_TEMP: temp });
    expect(r.code).toBe(0);
    const args = sb
      .log()
      .filter((l) => l.startsWith("ARG<"))
      .map((l) => l.slice(4, -1));
    expect(args).toEqual([
      "-s",
      "oa:hosted",
      "delete",
      "--env",
      "staging",
      "--install",
      "iabcdefghijk",
      "--confirm",
      "iabcdefghijk",
      "--skip-directory-revoke",
      reason,
    ]);
    expect(existsSync("/tmp/oa-pwned")).toBe(false);
    expect(readFileSync(join(temp, "hosted-ops-out.jsonl"), "utf8")).toContain(
      '"step":"note"',
    );
  });

  it("the inputs check refuses injection and never writes an argv", () => {
    const { sb, temp } = box();
    for (const env of [
      { OPS_ENV: "staging", OPS_OP: "status; id", OPS_INSTALL: "iabcdefghijk" },
      { OPS_ENV: "staging", OPS_OP: "status", OPS_INSTALL: "$(id)" },
      { OPS_ENV: "prod`id`", OPS_OP: "status", OPS_INSTALL: "iabcdefghijk" },
      {
        OPS_ENV: "staging",
        OPS_OP: "upgrade",
        OPS_INSTALL: "iabcdefghijk",
        OPS_TAG: "v1.2.3;id",
      },
      {
        OPS_ENV: "staging",
        OPS_OP: "update-vars",
        OPS_INSTALL: "iabcdefghijk",
        OPS_ARGS: '{"var":["AUTH_PROVIDERS=email\\nX=1"]}',
      },
    ] as Record<string, string>[]) {
      const r = bash(sb, named("Check the inputs").run, {
        RUNNER_TEMP: temp,
        ...env,
      });
      expect(r.code, JSON.stringify(env)).toBe(1);
      expect(r.err).toMatch(/^hosted-ops: refused: /);
      expect(readFileSync(join(temp, "hosted-ops-argv.json"), "utf8")).toBe("");
    }
  });

  it("the token-file step writes 0600 files in a 0700 dir, prints nothing, and skips R2 when unset", () => {
    const { sb, temp } = box();
    const tok = "cfut_SECRETVALUE_never_printed_123";
    const r = bash(sb, named("Write the token files").run, {
      RUNNER_TEMP: temp,
      PROVISION_TOKEN: tok,
      R2_TOKEN: "",
    });
    expect(r.code).toBe(0);
    expect(r.out + r.err).toBe("");
    const dir = join(temp, "hosted-ops-secrets");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "token"), "utf8")).toBe(`${tok}\n`);
    expect(existsSync(join(dir, "r2"))).toBe(false);
    const { sb: sb2, temp: t2 } = box();
    const r2 = bash(sb2, named("Write the token files").run, {
      RUNNER_TEMP: t2,
      PROVISION_TOKEN: tok,
      R2_TOKEN: "AKIDAKIDAKIDAKID:SECRETSECRETSECRET",
    });
    expect(r2.code).toBe(0);
    expect(statSync(join(t2, "hosted-ops-secrets", "r2")).mode & 0o777).toBe(
      0o600,
    );
    const { sb: sb3, temp: t3 } = box();
    const r3 = bash(sb3, named("Write the token files").run, {
      RUNNER_TEMP: t3,
      PROVISION_TOKEN: "",
      R2_TOKEN: "",
    });
    expect(r3.code).toBe(1);
    expect(r3.out).toMatch(/PROVISION_TOKEN is not set/);
  });

  describe("the sweep step", () => {
    const sweep = (env: Record<string, string>, out?: string) => {
      const { sb, temp } = box();
      if (out !== undefined)
        writeFileSync(join(temp, "hosted-ops-out.jsonl"), out);
      const r = bash(sb, named("Sweep the CI owner token").run, {
        RUNNER_TEMP: temp,
        GITHUB_RUN_ID: "4242",
        OPS_ENV: "prod",
        INSTALL: "",
        RUN_OUTCOME: "failure",
        ...env,
      });
      const args = sb
        .log()
        .filter((l) => l.startsWith("ARG<"))
        .map((l) => l.slice(4, -1));
      return { ...r, args };
    };
    const SWEEP = (id: string) => [
      "-s",
      "oa:hosted",
      "ci-token-sweep",
      "--env",
      "prod",
      "--install",
      id,
      "--run",
      "4242",
    ];

    it("sweeps the validated install", () => {
      const r = sweep({ INSTALL: "iabcdefghijk", RUN_OUTCOME: "success" });
      expect(r.code).toBe(0);
      expect(r.args).toEqual(SWEEP("iabcdefghijk"));
    });

    it("a create sweeps the install the CLI printed, even after a failure", () => {
      const r = sweep(
        {},
        '{"step":"create","status":"error"}\n{"step":"ci-owner-token","status":"ok","install":"izyxwvutsrqp"}\n',
      );
      expect(r.code).toBe(0);
      expect(r.args).toEqual(SWEEP("izyxwvutsrqp"));
    });

    it("refuses an install that is not an id", () => {
      const r = sweep(
        {},
        '{"step":"ci-owner-token","status":"ok","install":"$(id)"}\n',
      );
      expect(r.code).toBe(1);
      expect(r.args).toEqual([]);
    });

    it("nothing to sweep when the CLI finished without touching an install", () => {
      expect(sweep({ RUN_OUTCOME: "skipped" }).code).toBe(0);
      expect(
        sweep(
          {},
          '{"step":"token","status":"error"}\n{"step":"audit","status":"ok","message":"after row written"}\n',
        ).code,
      ).toBe(0);
    });

    it("fails loudly, naming the label, when the CLI never finished and the install is unknown", () => {
      const r = sweep({ RUN_OUTCOME: "cancelled" }, '{"step":"token"}\n');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/::error::.*ci-4242/);
      expect(r.args).toEqual([]);
    });
  });
});
