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
    const go = (env: Record<string, string>) => {
      const tmp = mkdtempSync(join(tmpdir(), "rl-targets-"));
      const ghEnv = join(tmp, "env");
      writeFileSync(ghEnv, "");
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
    const ok = go({
      TAG: "v0.82.0",
      REDLINE_PROD_INVENTORY_URL: "https://inv.p",
    });
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
    for (const bad of ["0.82.0", "v0.82", "v1.2.3; echo x", "main"]) {
      const r = go({ TAG: bad });
      expect(r.code).toBe(1);
      expect(r.out).toContain("tag must be vX.Y.Z");
    }
  });

  it("mints the three audiences, brings rl-a and rl-b up through the API, then the suite and T19", () => {
    expect(named("mint").run).toBe(
      "pnpm --filter @oa/redline provisioning mint-oidc provisioning stagingInventory prodInventory",
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
    expect(t19.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe("");
    expect(t19.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe("");
    expect(t19.run).toContain('T19_EXPECT_VERSION="$REDLINE_RELEASE"');
  });

  it("order: install, builds, targets, secrets, mint, bring-up, suite, T19, scan, uploads, revoke, remove", () => {
    const at = (pred: (s: Record<string, any>) => boolean) =>
      steps.findIndex(pred);
    const order = [
      at((s) => s.run === "pnpm install --frozen-lockfile"),
      at((s) => s.run === "pnpm --filter @oa/provision build"),
      at((s) => s.name === "Check the tag and set the targets"),
      at((s) => JSON.stringify(s).includes("secrets.")),
      at((s) => s.id === "mint"),
      at((s) => s.id === "bringup"),
      at((s) => (s.run ?? "").includes("@oa/redline live")),
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
      expect(u.if).toMatch(/^always\(\) && steps\.scan\.outcome == 'success'/);
      expect(steps.indexOf(u)).toBeGreaterThan(steps.indexOf(scan));
    }
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
