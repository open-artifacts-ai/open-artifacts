// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// hosted-ops.yml (OPS-B): one oa:hosted operation by hand, in the env's
// Environment (main only, no person approves a run: the automated gates
// decide), inputs only through env and the ci-args validator, secrets only in
// the step that writes the 0600 token files, an always() sweep of the
// ephemeral CI owner token, and the "prod is clean" precheck before a prod
// create or upgrade.
import { createHash } from "node:crypto";
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
    expect(w.permissions).toEqual({ contents: "read", actions: "read" });
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
      // Not an input: inputs are public, so create's owner email is a secret.
      OPS_OWNER:
        "${{ inputs.op == 'create' && secrets.CREATE_OWNER_EMAIL || '' }}",
      OPS_FLOOR_FILE: "${{ runner.temp }}/hosted-ops-floor.sig.json",
    });
    expect(named("Check the inputs").run).toContain(
      'node scripts/hosted/src/ci-args.ts > "$RUNNER_TEMP/hosted-ops-argv.json"',
    );
    expect(steps.indexOf(named("Check the inputs"))).toBeLessThan(
      steps.indexOf(named("Write the token files")),
    );
  });

  it("only the token-file step sees a token, exactly CLOUDFLARE_API_TOKEN; R2 and Turnstile are derived from it", () => {
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets.map((s) => s.name)).toEqual([
      "Check the inputs",
      "Write the token files",
    ]);
    // The input check sees one secret, create's owner email, and no token.
    const check = JSON.stringify(named("Check the inputs"));
    expect(check.match(/secrets\.[A-Z_]+/g)).toEqual([
      "secrets.CREATE_OWNER_EMAIL",
    ]);
    expect(JSON.stringify(w.on.workflow_dispatch.inputs)).not.toMatch(
      /owner"?\s*:/,
    );
    const s = named("Write the token files");
    expect(s.env).toEqual({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      OPS_ENV: "${{ inputs.env }}",
      OPS_OP: "${{ inputs.op }}",
    });
    // The old per-purpose secrets are gone (the precheck's read-only
    // REDLINE_PROD_R2_TOKEN is another secret).
    expect(text).not.toMatch(
      /(^|[^A-Z_])(PROVISION_TOKEN|R2_TOKEN|TURNSTILE_KEYS|ZONE_TOKEN)\b/m,
    );
    expect(s.run).toContain(
      'publish-release | publish-floor) bash scripts/ci/hosted-r2-key.sh "$dir/r2" ;;',
    );
    expect(s.run).toContain(
      'bash scripts/ci/hosted-turnstile-keys.sh "$OPS_ENV" "$dir/turnstile"',
    );
    // The CLI step learns the Turnstile file exists from a plain flag, never a secret.
    expect(named("Run the operation").env.OA_HOSTED_TURNSTILE_FILE).toBe(
      "${{ steps.tok.outputs.turnstile == '1' && format('{0}/hosted-ops-secrets/turnstile', runner.temp) || '' }}",
    );
    expect(s.run).toMatch(/^set \+x\n/);
    expect(s.run).toContain("umask 077");
    expect(JSON.stringify(w)).not.toContain("DEPLOY_TOKEN");
    // The op job reads no variables: the constants are committed.
    expect(JSON.stringify(job)).not.toContain("vars.");
    const load = named("Load the hosted constants");
    expect(load.env).toEqual({ OPS_ENV: "${{ inputs.env }}" });
    expect(load.run).toBe(
      'bash scripts/ci/hosted-constants.sh "$OPS_ENV" .github/hosted',
    );
    expect(load.if).toBeUndefined();
    expect(steps.indexOf(load)).toBeLessThan(
      steps.indexOf(named("Check the inputs")),
    );
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
    expect(rm.run).toContain('d="$RUNNER_TEMP/hosted-ops-secrets"');
    expect(rm.run).toContain('rm -f "$d/r2" "$d/turnstile" "$d/token"');
    // Run it: the derived R2 and Turnstile files (and the token) are gone.
    const sb = sandbox({});
    const temp = join(sb.dir, "runner-temp");
    const d = join(temp, "hosted-ops-secrets");
    mkdirSync(d, { recursive: true });
    for (const f of ["token", "r2", "turnstile"])
      writeFileSync(join(d, f), "x");
    const r = sb.run(["bash", "-c", rm.run], { env: { RUNNER_TEMP: temp } });
    expect(r.code, r.err).toBe(0);
    expect(existsSync(d)).toBe(false);
    // The step names the same files the CLI step reads.
    const cli = named("Run the operation").env;
    expect(cli.OA_HOSTED_R2_FILE).toBe(
      "${{ runner.temp }}/hosted-ops-secrets/r2",
    );
    expect(cli.OA_HOSTED_TURNSTILE_FILE).toContain(
      "'{0}/hosted-ops-secrets/turnstile'",
    );
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

  describe("the token-file step", () => {
    const tok = "cfut_SECRETVALUE_never_printed_123";
    const TOKEN_ID = "f".repeat(32);
    const SITEKEY = "0x4AAAAAAA0123456789";
    // Cloudflare: verify, the widget list and the widget's own GET; any call
    // without the token on stdin fails. VERIFY_STATUS: the token's status.
    const curl = `cfg="$(cat)"
case "$cfg" in *"$TOK_EXPECT"*) ;; *) echo '{"success":false}'; exit 0 ;; esac
case "\${@: -1}" in
  */user/tokens/verify) printf '{"success":true,"result":{"id":"%s","status":"%s"}}' "$TOKEN_ID" "$VERIFY_STATUS" ;;
  */challenges/widgets\\?*) printf '{"success":true,"result":[{"sitekey":"%s","name":"oa-p-turnstile"},{"sitekey":"0x4other","name":"oa-s-turnstile"}],"result_info":{"total_pages":1}}' "$SITEKEY" ;;
  */challenges/widgets/*) printf '{"success":true,"result":{"sitekey":"%s","secret":"SECRETturnstile"}}' "$SITEKEY" ;;
  *) echo '{"success":false}' ;;
esac`;
    const step = (op: string, env: Record<string, string> = {}) => {
      const sb = sandbox({ curl });
      const temp = join(sb.dir, "runner-temp");
      mkdirSync(temp);
      const output = join(temp, "github-output");
      writeFileSync(output, "");
      const r = sb.run(["bash", "-c", named("Write the token files").run], {
        cwd: root,
        env: {
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: output,
          CLOUDFLARE_API_TOKEN: tok,
          TOK_EXPECT: tok,
          TOKEN_ID,
          SITEKEY,
          VERIFY_STATUS: "active",
          CLOUDFLARE_ACCOUNT_ID: "26ac346086d4405f7a976d48747a2a75",
          OPS_ENV: "prod",
          OPS_OP: op,
          ...env,
        },
      });
      const dir = join(temp, "hosted-ops-secrets");
      const file = (n: string) => join(dir, n);
      const curls = sb.log().filter((l) => l.startsWith("curl "));
      return { ...r, dir, file, output, curls };
    };
    const masksOnly = (out: string) =>
      out
        .split("\n")
        .filter(Boolean)
        .every((l) => l.startsWith("::add-mask::"));

    it("writes the token to a 0600 file in a 0700 dir, prints nothing, and reads nothing else for a plain op", () => {
      const r = step("status");
      expect(r.code, r.err).toBe(0);
      expect(r.out + r.err).toBe("");
      expect(statSync(r.dir).mode & 0o777).toBe(0o700);
      expect(statSync(r.file("token")).mode & 0o777).toBe(0o600);
      expect(readFileSync(r.file("token"), "utf8")).toBe(`${tok}\n`);
      expect(existsSync(r.file("r2"))).toBe(false);
      expect(existsSync(r.file("turnstile"))).toBe(false);
      expect(readFileSync(r.output, "utf8")).toBe("");
      expect(r.curls).toEqual([]);
    });

    it("publish ops: the R2 key is <token id>:<sha256 of the token>, 0600, both halves masked first", () => {
      const sha = createHash("sha256").update(tok).digest("hex");
      for (const op of ["publish-release", "publish-floor"]) {
        const r = step(op);
        expect(r.code, r.err).toBe(0);
        expect(readFileSync(r.file("r2"), "utf8")).toBe(`${TOKEN_ID}:${sha}\n`);
        expect(statSync(r.file("r2")).mode & 0o777).toBe(0o600);
        expect(r.out).toBe(`::add-mask::${TOKEN_ID}\n::add-mask::${sha}\n`);
        expect(r.err).toBe("");
        expect(r.out + r.err).not.toContain(tok);
        // The token went to curl on stdin only.
        expect(r.curls.join("\n")).not.toContain(tok);
        expect(existsSync(r.file("turnstile"))).toBe(false);
      }
    });

    it("publish ops fail closed on a token that is not active or a failed verify", () => {
      for (const env of [
        { VERIFY_STATUS: "disabled" },
        { VERIFY_STATUS: "expired" },
        { TOK_EXPECT: "some-other-token" },
      ] as Record<string, string>[]) {
        const r = step("publish-release", env);
        expect(r.code, JSON.stringify(env)).toBe(1);
        expect(existsSync(r.file("r2"))).toBe(false);
        expect(masksOnly(r.out)).toBe(true);
        expect(r.out + r.err).not.toContain(tok);
      }
    });

    it("the vars ops: the Turnstile keys from the env's widget, 0600, the secret masked, and the flag", () => {
      for (const op of ["create", "upgrade", "rollback", "update-vars"]) {
        const r = step(op);
        expect(r.code, r.err).toBe(0);
        expect(readFileSync(r.file("turnstile"), "utf8")).toBe(
          `${SITEKEY}:SECRETturnstile\n`,
        );
        expect(statSync(r.file("turnstile")).mode & 0o777).toBe(0o600);
        expect(r.out).toBe("::add-mask::SECRETturnstile\n");
        expect(readFileSync(r.output, "utf8")).toBe("turnstile=1\n");
        expect(existsSync(r.file("r2"))).toBe(false);
      }
      // A failed lookup fails the step: no file, no flag.
      const bad = step("create", { TOK_EXPECT: "some-other-token" });
      expect(bad.code).toBe(1);
      expect(existsSync(bad.file("turnstile"))).toBe(false);
      expect(readFileSync(bad.output, "utf8")).toBe("");
    });

    it("refuses an unset token", () => {
      const r = step("status", { CLOUDFLARE_API_TOKEN: "" });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/CLOUDFLARE_API_TOKEN is not set/);
      expect(existsSync(r.file("token"))).toBe(false);
    });
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

describe("the release gate: every release op checks its tag first", () => {
  const GATE_OPS = ["create", "upgrade", "publish-release"];
  const gate = () => named("Release gate");
  /** Whether a step `if` of the contains(fromJSON([...]), inputs.op) shape runs for op. */
  const runsFor = (expr: string, op: string): boolean => {
    const m =
      /^\$\{\{ contains\(fromJSON\('(\[[^']*\])'\), inputs\.op\) \}\}$/.exec(
        expr,
      );
    if (!m) throw new Error(`unexpected if: ${expr}`);
    return (JSON.parse(m[1] as string) as string[]).includes(op);
  };

  it("runs main's tag-passed-checks.sh on the validated tag, for every release op", () => {
    const s = gate();
    expect(s.run).toBe('scripts/ci/tag-passed-checks.sh "$OPS_ENV" "$RELEASE"');
    expect(existsSync(join(root, "scripts/ci/tag-passed-checks.sh"))).toBe(
      true,
    );
    expect(s.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      OPS_ENV: "${{ inputs.env }}",
      RELEASE: "${{ steps.args.outputs.release }}",
    });
    for (const op of w.on.workflow_dispatch.inputs.op.options as string[])
      expect(runsFor(s.if, op), op).toBe(GATE_OPS.includes(op));
    expect(s["continue-on-error"]).toBeUndefined();
  });

  it("comes right after the inputs check, before any token is read or the CLI runs", () => {
    const i = (n: string) => steps.indexOf(named(n));
    expect(i("Release gate")).toBe(i("Check the inputs") + 1);
    expect(i("Release gate")).toBeLessThan(i("Write the token files"));
    expect(i("Release gate")).toBeLessThan(i("Run the operation"));
    // The steps between the gate and the CLI all run for every gated op.
    for (const st of steps.slice(
      i("Release gate") + 1,
      i("Run the operation") + 1,
    ))
      expect(st.if, st.name).toBeUndefined();
  });

  it("fails closed on an empty release (an op the inputs check gave none)", () => {
    const sb = sandbox({});
    const r = sb.run(["bash", "-c", gate().run], {
      cwd: root,
      env: {
        OPS_ENV: "prod",
        RELEASE: "",
        GH_TOKEN: "x",
        GITHUB_REPOSITORY: "o/r",
      },
    });
    expect(r.code).not.toBe(0);
  });

  it("the inputs check writes the version to install or publish as release=vX.Y.Z", () => {
    const sb = sandbox({});
    const temp = join(sb.dir, "runner-temp");
    mkdirSync(temp);
    const cases: [Record<string, string>, string][] = [
      [
        { OPS_OP: "upgrade", OPS_INSTALL: "iabcdefghijk", OPS_TAG: "v0.75.0" },
        "v0.75.0",
      ],
      [
        {
          OPS_OP: "create",
          OPS_TAG: "",
          OPS_ARGS: '{"slug":"finqore","to":"0.74.1"}',
          OPS_OWNER: "ops@finqore.test",
        },
        "v0.74.1",
      ],
      [{ OPS_OP: "publish-release", OPS_TAG: "v0.74.1" }, "v0.74.1"],
      [{ OPS_OP: "status", OPS_INSTALL: "iabcdefghijk" }, ""],
    ];
    for (const [env, want] of cases) {
      const out = join(temp, `out-${env.OPS_OP}`);
      writeFileSync(out, "");
      const r = sb.run(["bash", "-c", named("Check the inputs").run], {
        cwd: root,
        env: {
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: out,
          OPS_ENV: "staging",
          OPS_ARGS: "{}",
          ...env,
        },
      });
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(out, "utf8")).toContain(`release=${want}\n`);
    }
  });
});

describe("the precheck job: prod is clean before a prod create or upgrade", () => {
  const pre = w.jobs.precheck;
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  const psteps: Record<string, any>[] = pre.steps;
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  const pnamed = (n: string): Record<string, any> => {
    const s = psteps.find((x) => x.name === n);
    if (!s) throw new Error(`no precheck step ${n}`);
    return s;
  };
  const GATED =
    "inputs.env == 'prod' && (inputs.op == 'create' || inputs.op == 'upgrade')";

  /** Evaluates a job `if` for one dispatch (==, &&, ||, !, parens, 'strings'). */
  const evalIf = (
    expr: string,
    v: { env: string; op: string; precheck: string; cancelled?: boolean },
  ): boolean => {
    const js = expr
      .replace(/^\$\{\{\s*/, "")
      .replace(/\s*\}\}$/, "")
      .replace(/!cancelled\(\)/g, String(!v.cancelled))
      .replace(/needs\.precheck\.result/g, JSON.stringify(v.precheck))
      .replace(/inputs\.env/g, JSON.stringify(v.env))
      .replace(/inputs\.op/g, JSON.stringify(v.op))
      .replace(/'([^']*)'/g, (_, x) => JSON.stringify(x))
      .replace(/==/g, "===");
    expect(js).toMatch(/^[\s"a-z\-()!&|=]+$/);
    return new Function(`return (${js});`)() as boolean;
  };
  const OPS: string[] = w.on.workflow_dispatch.inputs.op.options;

  it("runs only for prod create and upgrade, in redline-staging, from main", () => {
    expect(pre.if).toBe(`\${{ ${GATED} }}`);
    expect(pre.environment).toBe("redline-staging");
    expect(pre.permissions).toBeUndefined();
    expect(pre["timeout-minutes"]).toBeLessThanOrEqual(15);
    const main = pnamed("Prod runs only from main");
    expect(psteps.indexOf(main)).toBe(0);
    expect(main.run).toBe('test "$REF" = refs/heads/main');
    expect(main.env).toEqual({ REF: "${{ github.ref }}" });
    for (const s of psteps.filter((s) => s.uses)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
      if (String(s.uses).startsWith("actions/checkout@")) {
        expect(s.with["persist-credentials"]).toBe(false);
        expect(s.with.ref).toBe("${{ github.sha }}");
      }
    }
    for (const s of psteps)
      if (typeof s.run === "string") expect(s.run, s.name).not.toContain("${{");
  });

  it("only the token-file step sees secrets; the check reads them by path and runs the CLI", () => {
    expect(
      psteps
        .filter((s) => JSON.stringify(s).includes("secrets."))
        .map((s) => s.name),
    ).toEqual(["Write the prod probe's token files"]);
    expect(pnamed("Write the prod probe's token files").env).toEqual({
      PROD_R2_TOKEN: "${{ secrets.REDLINE_PROD_R2_TOKEN }}",
      PROD_SCRIPTS_TOKEN: "${{ secrets.REDLINE_PROD_SCRIPTS_TOKEN }}",
      PROD_INVENTORY_KEY: "${{ secrets.REDLINE_PROD_INVENTORY_KEY }}",
    });
    const check = pnamed("Prod is clean");
    expect(check.env).toEqual({
      OPS_OP: "${{ inputs.op }}",
      REDLINE_PROD_SECRETS_DIR: "${{ runner.temp }}/prod-clean-secrets",
      REDLINE_PROD_ACCOUNT_ID: "${{ vars.REDLINE_PROD_ACCOUNT_ID }}",
      REDLINE_PROD_INVENTORY_URL: "${{ vars.REDLINE_PROD_INVENTORY_URL }}",
    });
    expect(check.run).toBe("node tests/redline/src/prod-clean-cli.ts");
    expect(existsSync(join(root, "tests/redline/src/prod-clean-cli.ts"))).toBe(
      true,
    );
    const rm = pnamed("Remove the token files");
    expect(rm.if).toBe("${{ always() }}");
    expect(rm.run).toContain('"$RUNNER_TEMP/prod-clean-secrets"');
    const i = (n: string) => psteps.indexOf(pnamed(n));
    expect(i("Write the prod probe's token files")).toBeLessThan(
      i("Prod is clean"),
    );
    expect(i("Prod is clean")).toBeLessThan(i("Remove the token files"));
  });

  it("op needs precheck: a prod create or upgrade runs only after it passed", () => {
    expect(job.needs).toBe("precheck");
    for (const env of ["staging", "prod"])
      for (const op of OPS) {
        const gated = env === "prod" && (op === "create" || op === "upgrade");
        expect(evalIf(pre.if, { env, op, precheck: "" }), `${env} ${op}`).toBe(
          gated,
        );
        const ran = (precheck: string) => evalIf(job.if, { env, op, precheck });
        if (gated) {
          expect(ran("success"), `${env} ${op}`).toBe(true);
          for (const r of ["failure", "skipped", "cancelled"])
            expect(ran(r), `${env} ${op} ${r}`).toBe(false);
        } else expect(ran("skipped"), `${env} ${op}`).toBe(true);
        expect(
          evalIf(job.if, { env, op, precheck: "success", cancelled: true }),
        ).toBe(false);
      }
  });

  it("the token-file step writes 0600 files in a 0700 dir, prints nothing, and refuses an empty secret", () => {
    const sb = sandbox({});
    const temp = join(sb.dir, "runner-temp");
    mkdirSync(temp);
    const run = pnamed("Write the prod probe's token files").run;
    const env = {
      RUNNER_TEMP: temp,
      PROD_R2_TOKEN: "r2-SECRET",
      PROD_SCRIPTS_TOKEN: "scripts-SECRET",
      PROD_INVENTORY_KEY: "inv-SECRET",
    };
    const r = sb.run(["bash", "-c", run], { cwd: root, env });
    expect(r.code).toBe(0);
    expect(r.out + r.err).toBe("");
    const d = join(temp, "prod-clean-secrets");
    expect(statSync(d).mode & 0o777).toBe(0o700);
    for (const f of [
      "REDLINE_PROD_R2_TOKEN",
      "REDLINE_PROD_SCRIPTS_TOKEN",
      "REDLINE_PROD_INVENTORY_KEY",
    ])
      expect(statSync(join(d, f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(d, "REDLINE_PROD_R2_TOKEN"), "utf8")).toBe(
      "r2-SECRET",
    );
    const sb2 = sandbox({});
    const t2 = join(sb2.dir, "runner-temp");
    mkdirSync(t2);
    const r2 = sb2.run(["bash", "-c", run], {
      cwd: root,
      env: { ...env, RUNNER_TEMP: t2, PROD_INVENTORY_KEY: "" },
    });
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("empty secret file: REDLINE_PROD_INVENTORY_KEY");
  });
});
