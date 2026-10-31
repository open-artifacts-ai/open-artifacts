// redline-staging.yml: the red-line suite against rl-a and rl-b, on demand.
// Secrets live only in the redline-staging Environment and reach the suite as
// 0600 files by path; no other step sees them.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const text = readFileSync(
  join(root, ".github/workflows/redline-staging.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const w: any = parse(text);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const job: any = w.jobs.redline;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const steps: Record<string, any>[] = job.steps;
const SHA_PIN =
  /^(actions\/(checkout|upload-artifact|setup-node)|pnpm\/action-setup)@[0-9a-f]{40}$/;
const SECRETS = ["REDLINE_PROD_R2_TOKEN", "REDLINE_PROD_SCRIPTS_TOKEN"];
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const named = (n: string): Record<string, any> => {
  const s = steps.find((x) => x.name === n || x.id === n);
  if (!s) throw new Error(`no step ${n}`);
  return s;
};
const runBash = (script: string, env: Record<string, string>) =>
  spawnSync("bash", ["-c", script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

describe("redline-staging.yml", () => {
  it("runs only on demand for a tag, in the redline-staging Environment, bounded; id-token on the job only", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(w.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(w.permissions).toEqual({ contents: "read" });
    expect(Object.keys(w.jobs)).toEqual(["redline"]);
    expect(job.environment).toBe("redline-staging");
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job["timeout-minutes"]).toBe(150);
    expect(w.concurrency).toEqual({
      group: "redline",
      "cancel-in-progress": false,
    });
  });

  it("names each run after its tag, the shape staging-first-gate.sh matches", () => {
    expect(w["run-name"]).toBe("redline-staging ${{ inputs.tag }}");
    const gateTest = readFileSync(
      join(root, "scripts/ci/staging-first-gate.test.ts"),
      "utf8",
    );
    expect(gateTest).toContain("display_title: `redline-staging ${TAG}`");
  });

  it("pins every action by SHA and keeps no git credentials", () => {
    for (const s of steps) if (s.uses) expect(s.uses).toMatch(SHA_PIN);
    expect(steps[0]?.with?.["persist-credentials"]).toBe(false);
    for (const s of steps) expect(s.with?.cache).toBeUndefined();
  });

  it("no stored red-line or inventory key: only the prod probe's two tokens are secrets", () => {
    expect(text).not.toMatch(/INVENTORY_KEY|REDLINE_RL_/);
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets).toHaveLength(1);
    const st = withSecrets[0] as Record<string, any>;
    expect(st.run).not.toContain("secrets.");
    expect(Object.values(st.env as object).sort()).toEqual(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expressions
      SECRETS.map((n) => "${{ secrets." + n + " }}").sort(),
    );
    expect(st.run).toMatch(/^set -euo pipefail\numask 077\n/);
    for (const n of SECRETS) expect(st.run).toContain(`> "$d/${n}"`);
    expect(job.env).toBeUndefined();
    expect(w.env).toBeUndefined();
  });

  it("the prod probe's files: written only when its secrets are set, both or the job fails", () => {
    const st = named("Write the suite's secrets as 0600 files");
    const write = (prod: Record<string, string>) => {
      const tmp = mkdtempSync(join(tmpdir(), "rl-write-"));
      try {
        const r = runBash(String(st.run), {
          RUNNER_TEMP: tmp,
          // Actions passes a missing secret as an empty string.
          PROD_R2_TOKEN: "",
          PROD_SCRIPTS_TOKEN: "",
          ...prod,
        });
        const d = join(tmp, "redline-secrets");
        const files = r.status === 0 ? readdirSync(d).sort() : [];
        return { code: r.status, files, out: r.stdout };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
    const none = write({});
    expect(none.code).toBe(0);
    expect(none.files).toEqual([]);
    const all = write({ PROD_R2_TOKEN: "r", PROD_SCRIPTS_TOKEN: "s" });
    expect(all.code).toBe(0);
    expect(all.files).toEqual([
      "REDLINE_PROD_R2_TOKEN",
      "REDLINE_PROD_SCRIPTS_TOKEN",
    ]);
    // A partial set is a misconfiguration: the empty-file check stops the job.
    const partial = write({ PROD_R2_TOKEN: "r" });
    expect(partial.code).toBe(1);
    expect(partial.out).toContain("empty secret file: REDLINE_PROD_");
  });

  it("the targets step checks the tag and sets REDLINE_TARGETS, REDLINE_RELEASE and REDLINE_RUN_ID", () => {
    const st = named("Check the tag and set the targets");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(st.env.TAG).toBe("${{ inputs.tag }}");
    expect(st.run).not.toContain("${{");
    const go = (env: Record<string, string>, prodTokens = false) => {
      const tmp = mkdtempSync(join(tmpdir(), "rl-targets-"));
      const ghEnv = join(tmp, "env");
      writeFileSync(ghEnv, "");
      if (prodTokens) {
        mkdirSync(join(tmp, "redline-secrets"));
        writeFileSync(
          join(tmp, "redline-secrets", "REDLINE_PROD_R2_TOKEN"),
          "r",
        );
      }
      try {
        const r = runBash(String(st.run), {
          RUNNER_TEMP: tmp,
          GITHUB_ENV: ghEnv,
          REDLINE_TARGETS_BASE:
            '{"mode":"staging","a":{"name":"rl-a"},"b":{"name":"rl-b"}}',
          RUN_ID: "123-1",
          ...env,
        });
        return {
          code: r.status,
          out: r.stdout,
          env: readFileSync(ghEnv, "utf8"),
          tmp,
        };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
    const ok = go(
      { TAG: "v0.82.0", REDLINE_PROD_INVENTORY_URL: "https://inv.p" },
      true,
    );
    expect(ok.code).toBe(0);
    const lines = Object.fromEntries(
      ok.env
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(lines.REDLINE_RELEASE).toBe("0.82.0");
    expect(lines.REDLINE_RUN_ID).toBe("123-1");
    const t = JSON.parse(lines.REDLINE_TARGETS as string);
    expect(t.secretsDir).toBe(join(ok.tmp, "redline-secrets"));
    expect(t.a.turnstileFile).toBe(join(ok.tmp, "redline-turnstile-token"));
    expect(t.prod).toEqual({ inventoryUrl: "https://inv.p" });
    // No prod tokens: no .prod, so loadTargets reports prod not-applicable
    // instead of failing on the missing token files.
    const noTokens = go({
      TAG: "v0.82.0",
      REDLINE_PROD_INVENTORY_URL: "https://inv.p",
    });
    expect(noTokens.code).toBe(0);
    const t2 = JSON.parse(
      (
        noTokens.env.match(/^REDLINE_TARGETS=(.*)$/m) as RegExpMatchArray
      )[1] as string,
    );
    expect(t2.prod).toBeUndefined();
    for (const bad of ["0.82.0", "v0.82", "v1.2.3; echo x", "main"]) {
      const r = go({ TAG: bad });
      expect(r.code).toBe(1);
      expect(r.out).toContain("tag must be vX.Y.Z");
    }
  });

  it("mints the staging audiences, brings rl-a and rl-b up, mints prod's after bring-up, then the suite and T19", () => {
    expect(named("mint").run).toBe(
      "pnpm --filter @oa/redline provisioning mint-oidc provisioning stagingInventory",
    );
    const prodMint = named("Mint the prod inventory OIDC JWT");
    expect(prodMint.run).toContain(
      'if [ -s "$RUNNER_TEMP/redline-secrets/REDLINE_PROD_R2_TOKEN" ]; then',
    );
    expect(prodMint.run).toContain("mint-oidc prodInventory");
    expect(steps.indexOf(prodMint)).toBeGreaterThan(
      steps.indexOf(named("bringup")),
    );
    expect(named("bringup").run).toBe(
      "pnpm --filter @oa/redline provisioning bringup",
    );
    expect(text).not.toContain("redline-deploy.sh");
    const suite = named("Run the suite");
    expect(suite.run).toContain("pnpm --filter @oa/redline live");
    expect(suite.run).not.toMatch(/--gate|REDLINE_GATE/);
    const t19 = named("t19");
    expect(t19.if).toBe(
      "${{ !cancelled() && steps.bringup.outcome == 'success' }}",
    );
    expect(t19.run).toContain('T19_EXPECT_VERSION="$REDLINE_RELEASE"');
  });

  it("T19 shares the id-token job (a recorded deviation from 4.4), so every JWT and prod file is gone before it runs", () => {
    expect(text).toContain(
      'Deviation from 4.4 ("id-token on the redline job only, not t19")',
    );
    const drop = named("Delete the JWT and prod files before T19");
    expect(drop.if).toBe("always()");
    expect(steps.indexOf(drop)).toBe(steps.indexOf(named("t19")) - 1);
    expect(steps.indexOf(named("scan-suite"))).toBeLessThan(
      steps.indexOf(drop),
    );
    const tmp = mkdtempSync(join(tmpdir(), "rl-drop-"));
    try {
      const d = join(tmp, "redline-secrets");
      mkdirSync(d);
      for (const f of [
        "REDLINE_PROVISIONING_OIDC",
        "REDLINE_STG_INVENTORY_OIDC",
        "REDLINE_PROD_INVENTORY_OIDC",
        "REDLINE_MINTED_OIDC",
        "REDLINE_PROD_R2_TOKEN",
        "REDLINE_PROD_SCRIPTS_TOKEN",
        "REDLINE_RL_A_HOOK_KEY",
        "REDLINE_RL_A_PAT",
      ])
        writeFileSync(join(d, f), "x");
      expect(runBash(String(drop.run), { RUNNER_TEMP: tmp }).status).toBe(0);
      expect(readdirSync(d).sort()).toEqual([
        "REDLINE_RL_A_HOOK_KEY",
        "REDLINE_RL_A_PAT",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("T19's shell unsets the OIDC request variables and refuses to start if either survives", () => {
    const t19 = named("t19");
    expect(t19.env).toMatchObject({
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
    });
    const run = String(t19.run);
    const pre = run.slice(0, run.indexOf("export T19_EXPECT_VERSION"));
    expect(pre).toContain(
      "unset ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    );
    const vars = {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "tok",
    };
    const r = runBash(`${pre}\nenv`, vars);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("ACTIONS_ID_TOKEN_REQUEST_");
    // The guard itself: without the unset, a surviving variable stops T19.
    const guard = pre.replace(/^\s*unset ACTIONS_ID_TOKEN_REQUEST_URL.*$/m, "");
    const g = runBash(guard, vars);
    expect(g.status).toBe(1);
    expect(g.stdout).toContain("T19 can reach the OIDC request variables");
  });

  it("installs without lifecycle scripts: every step of the job can reach the OIDC request token", () => {
    expect(
      steps.some(
        (s) => s.run === "pnpm install --frozen-lockfile --ignore-scripts",
      ),
    ).toBe(true);
    expect(steps.some((s) => s.run === "pnpm install --frozen-lockfile")).toBe(
      false,
    );
  });

  it("order: install, builds, secrets, targets, mint, bring-up, prod mint, suite, suite scan, drop, T19, scan, uploads, revoke, remove", () => {
    const at = (pred: (s: Record<string, any>) => boolean) =>
      steps.findIndex(pred);
    const order = [
      at((s) => s.run === "pnpm install --frozen-lockfile --ignore-scripts"),
      at((s) => s.run === "pnpm --filter @oa/provision build"),
      at((s) => JSON.stringify(s).includes("secrets.")),
      at((s) => s.name === "Check the tag and set the targets"),
      at((s) => s.id === "mint"),
      at((s) => s.id === "bringup"),
      at((s) => s.name === "Mint the prod inventory OIDC JWT"),
      at((s) => (s.run ?? "").includes("@oa/redline live")),
      at((s) => s.id === "scan-suite"),
      at((s) => s.name === "Delete the JWT and prod files before T19"),
      at((s) => s.id === "t19"),
      at((s) => s.id === "scan"),
      at((s) => String(s.uses ?? "").startsWith("actions/upload-artifact")),
      at((s) => (s.run ?? "").includes("provisioning revoke")),
      at((s) => (s.run ?? "").includes("rm -rf")),
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual(order.slice().sort((x, y) => x - y));
    // The job ends with the revoke and the file removal, both always.
    expect(steps.slice(-2).map((s) => s.name)).toEqual([
      "Revoke this run's R26 credentials",
      "Remove the secret files",
    ]);
    expect(steps.at(-2)?.if).toBe(
      "always() && steps.mint.outcome == 'success'",
    );
    expect(steps.at(-1)?.if).toBe("always()");
    expect(steps.at(-1)?.run).toBe(
      'rm -rf "$RUNNER_TEMP/redline-secrets" "$RUNNER_TEMP/redline-turnstile-token"',
    );
    expect(
      steps.filter((s) => (s.run ?? "").includes("@oa/provision build")),
    ).toHaveLength(1);
  });

  it("a secret file's contents anywhere in either report fails the job and stops both uploads", () => {
    const scan = named("scan");
    expect(scan.if).toBe("always()");
    // -f: the key is read from its file, never put in argv.
    expect(scan.run).toContain(
      'if grep -rqF -f "$f" "${dirs[@]}"; then echo "secret in report: ${f##*/}"; exit 1; fi',
    );
    expect(scan.run).not.toContain("$(cat");
    const up = steps.filter((s) =>
      String(s.uses ?? "").startsWith("actions/upload-artifact"),
    );
    expect(up).toHaveLength(2);
    for (const u of up) {
      expect(u.if).toMatch(
        /^always\(\) && (steps\.scan-suite\.outcome == 'success' && )?steps\.scan\.outcome == 'success'/,
      );
      expect(steps.indexOf(u)).toBeGreaterThan(steps.indexOf(scan));
    }
    expect(up[0]?.if).toContain("steps.scan-suite.outcome == 'success'");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(up.map((u) => u.with?.path)).toEqual([
      "${{ runner.temp }}/redline-report",
      "apps/dashboard/playwright-report",
    ]);
  });

  it("the scan step fails on a leaked key or JWT and passes a clean report", () => {
    const scan = named("scan");
    const tmp = mkdtempSync(join(tmpdir(), "rl-scan-"));
    try {
      mkdirSync(join(tmp, "redline-secrets"));
      mkdirSync(join(tmp, "redline-report"));
      writeFileSync(
        join(tmp, "redline-secrets", "REDLINE_RL_A_PAT"),
        "oa_pat_s3cret",
      );
      writeFileSync(
        join(tmp, "redline-secrets", "REDLINE_PROVISIONING_OIDC"),
        "eyJ.eyJ.sig",
      );
      const run = () => runBash(String(scan.run), { RUNNER_TEMP: tmp });
      writeFileSync(join(tmp, "redline-report", "r.txt"), "all clear");
      expect(run().status).toBe(0);
      writeFileSync(join(tmp, "redline-report", "r.txt"), "x oa_pat_s3cret y");
      const leak = run();
      expect(leak.status).toBe(1);
      expect(leak.stdout).toContain("secret in report: REDLINE_RL_A_PAT");
      expect(leak.stdout).not.toContain("oa_pat_s3cret");
      writeFileSync(join(tmp, "redline-report", "r.txt"), "jwt eyJ.eyJ.sig");
      expect(run().stdout).toContain(
        "secret in report: REDLINE_PROVISIONING_OIDC",
      );
      // A JWT a re-mint replaced lives on only in the minted list.
      writeFileSync(
        join(tmp, "redline-secrets", "REDLINE_MINTED_OIDC"),
        "eyJ.old.sig\neyJ.eyJ.sig\n",
      );
      writeFileSync(join(tmp, "redline-report", "r.txt"), "jwt eyJ.old.sig");
      const old = run();
      expect(old.status).toBe(1);
      expect(old.stdout).toContain("secret in report: REDLINE_MINTED_OIDC");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the live suite prints each case as it runs and still writes the report", () => {
    const cfg = readFileSync(
      join(root, "tests/redline/vitest.live.config.ts"),
      "utf8",
    );
    expect(cfg).toContain('reporters: ["verbose", "./src/reporter.ts"],');
  });

  it("both targets send Cloudflare's dummy Turnstile token from a 0600 file outside the secrets dir", () => {
    const st = named("Check the tag and set the targets");
    expect(st.run).toContain('t="$RUNNER_TEMP/redline-turnstile-token"');
    expect(st.run).toContain(`printf '%s' 'XXXX.DUMMY.TOKEN.XXXX' > "$t"`);
    expect(st.run).toMatch(/umask 077[\s\S]*printf '%s' 'XXXX/);
    expect(st.run).not.toContain("redline-secrets/redline-turnstile");
  });

  it("the OIDC audiences the probes mint match the API's and the inventories' configs", () => {
    const strip = (f: string) =>
      readFileSync(join(root, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const oidc = readFileSync(join(root, "tests/redline/src/oidc.ts"), "utf8");
    const api = strip("apps/provisioning/wrangler.jsonc").match(
      /"OIDC_AUDIENCE":\s*"([^"]+)"/,
    )?.[1];
    expect(api).toBeTruthy();
    expect(oidc).toContain(`provisioning: "${api}"`);
    expect(oidc).toContain('stagingInventory: "https://oa-s-inventory"');
    expect(oidc).toContain('prodInventory: "https://oa-p-inventory"');
    expect(strip("apps/provisioning/wrangler.jsonc")).toContain(
      "redline-staging.yml@refs/heads/main",
    );
  });
});
