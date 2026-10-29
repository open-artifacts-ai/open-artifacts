import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root, sandbox, write } from "../ci/stubs.ts";

// The platform Worker deploy wrapper: an allowlisted app and one env, always from the app's dir,
// this env's placeholders filled into a copy that is removed on exit, and
// exactly `pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env <env>`.
const SCRIPT = join(root, "scripts/ops/deploy-platform-worker.sh");
const APP = join(root, "apps/auth-broker");
const COPY = join(APP, "wrangler.deploy.jsonc");
const REG = "0123456789abcdef0123456789abcdef";
const CLIENT = "123456-abcdef.apps.googleusercontent.com";

// pnpm stub: records its cwd and whether the copy exists, and snapshots it.
const pnpm = `pwd >> "$STUB_LOG"; test -f wrangler.deploy.jsonc && echo copy-present >> "$STUB_LOG"; cp wrangler.deploy.jsonc "$SNAP" 2>/dev/null || true`;

const run = (
  args: string[],
  env: Record<string, string> = {},
  script = SCRIPT,
) => {
  const sb = sandbox({ pnpm });
  const snap = join(sb.dir, "snap.jsonc");
  const r = sb.run(["bash", script, ...args], {
    cwd: sb.dir,
    env: { SNAP: snap, ...env },
  });
  return { ...r, log: sb.log(), snap };
};

afterEach(() => expect(existsSync(COPY)).toBe(false));

describe("deploy-platform-worker.sh", () => {
  it("staging: deploys from apps/auth-broker with exact argv, then removes the copy", () => {
    const r = run(["auth-broker", "staging"], { BROKER_REGISTRY_ID: REG });
    expect(r.code).toBe(0);
    expect(r.log).toEqual([
      "pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env staging",
      APP,
      "copy-present",
    ]);
    const snap = readFileSync(r.snap, "utf8");
    expect(snap).toContain(`"id": "${REG}"`);
    expect(snap).not.toContain("{{BROKER_REGISTRY_ID_STAGING}}");
    expect(r.out + r.err).not.toContain(REG);
  });

  it("prod: fills the registry id and the prod client id", () => {
    const r = run(["auth-broker", "prod"], {
      BROKER_REGISTRY_ID: REG,
      GOOGLE_CLIENT_ID_PROD: CLIENT,
    });
    expect(r.code).toBe(0);
    expect(r.log[0]).toBe(
      "pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env prod",
    );
    const snap = readFileSync(r.snap, "utf8");
    expect(snap).toContain(CLIENT);
    expect(snap).not.toMatch(/\{\{[A-Z0-9_]*_PROD\}\}/);
  });

  it("refuses a bad env, no env and extra args without deploying", () => {
    for (const args of [
      ["auth-broker", "dev"],
      ["auth-broker"],
      [],
      ["auth-broker", "staging", "x"],
      ["auth-broker", "staging", "--name"],
      ["staging"],
    ]) {
      const r = run(args, { BROKER_REGISTRY_ID: REG });
      expect(r.code).toBe(2);
      expect(r.log).toEqual([]);
    }
  });

  it("refuses an app that isn't in the allowlist", () => {
    for (const a of ["dispatch", "../auth-broker", "apps/auth-broker", ""]) {
      const r = run([a, "staging"], { BROKER_REGISTRY_ID: REG });
      expect(r.code).toBe(2);
      expect(r.log).toEqual([]);
    }
  });

  it("refuses a missing or malformed registry id", () => {
    for (const id of ["", "abc", `${REG}/x`, "../../etc"]) {
      const r = run(["auth-broker", "staging"], { BROKER_REGISTRY_ID: id });
      expect(r.code).toBe(1);
      expect(r.log).toEqual([]);
    }
  });

  it("prod refuses while the client id placeholder is unfilled", () => {
    const r = run(["auth-broker", "prod"], { BROKER_REGISTRY_ID: REG });
    expect(r.code).toBe(1);
    expect(r.log).toEqual([]);
    expect(r.err).toContain("{{GOOGLE_CLIENT_ID_PROD}}");
    expect(r.err).not.toContain(REG);
  });

  it("prod refuses a client id that isn't a Google client id", () => {
    const r = run(["auth-broker", "prod"], {
      BROKER_REGISTRY_ID: REG,
      GOOGLE_CLIENT_ID_PROD: "x/y&z",
    });
    expect(r.code).toBe(1);
    expect(r.log).toEqual([]);
  });

  describe("directory-broker", () => {
    const DIR = join(root, "apps/directory-broker");
    const DCLIENT = "654321-fedcba.apps.googleusercontent.com";

    it("staging: deploys from apps/directory-broker with exact argv and fills its registry id", () => {
      const r = run(["directory-broker", "staging"], {
        DIRECTORY_REGISTRY_ID: REG,
      });
      expect(r.code).toBe(0);
      expect(r.log).toEqual([
        "pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env staging",
        DIR,
        "copy-present",
      ]);
      const snap = readFileSync(r.snap, "utf8");
      expect(snap).toContain(`"id": "${REG}"`);
      expect(snap).not.toContain("{{DIRECTORY_REGISTRY_ID_STAGING}}");
      expect(existsSync(join(DIR, "wrangler.deploy.jsonc"))).toBe(false);
    });

    it("prod: fills the registry id and the Directory client id", () => {
      const r = run(["directory-broker", "prod"], {
        DIRECTORY_REGISTRY_ID: REG,
        GOOGLE_DIRECTORY_CLIENT_ID_PROD: DCLIENT,
      });
      expect(r.code).toBe(0);
      const snap = readFileSync(r.snap, "utf8");
      expect(snap).toContain(DCLIENT);
      expect(snap).not.toMatch(/\{\{[A-Z0-9_]*_PROD\}\}/);
    });

    it("refuses a missing registry id, the auth broker's variable and an unfilled prod client", () => {
      for (const [args, env] of [
        [["directory-broker", "staging"], {}],
        [["directory-broker", "staging"], { BROKER_REGISTRY_ID: REG }],
        [["directory-broker", "prod"], { DIRECTORY_REGISTRY_ID: REG }],
        [
          ["directory-broker", "prod"],
          {
            DIRECTORY_REGISTRY_ID: REG,
            GOOGLE_DIRECTORY_CLIENT_ID_PROD: "x/y&z",
          },
        ],
      ] as [string[], Record<string, string>][]) {
        const r = run(args, env);
        expect(r.code).toBe(1);
        expect(r.log).toEqual([]);
      }
    });
  });
  describe("billing", () => {
    const DIR = join(root, "apps/billing");
    const DB = "0123abcd-4567-89ef-0123-456789abcdef";

    for (const env of ["staging", "prod"] as const)
      it(`${env}: deploys from apps/billing with exact argv and fills its D1 and registry ids`, () => {
        const r = run(["billing", env], {
          BILLING_DB_ID: DB,
          BROKER_REGISTRY_ID: REG,
        });
        expect(r.code).toBe(0);
        expect(r.log).toEqual([
          `pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env ${env}`,
          DIR,
          "copy-present",
        ]);
        const snap = readFileSync(r.snap, "utf8");
        const up = env.toUpperCase();
        expect(snap).toContain(`"database_id": "${DB}"`);
        expect(snap).toContain(`"id": "${REG}"`);
        expect(snap).not.toContain(`{{BILLING_DB_ID_${up}}}`);
        expect(snap).not.toContain(`{{BROKER_REGISTRY_ID_${up}}}`);
        // Only this env's placeholders are filled.
        const other = env === "staging" ? "PROD" : "STAGING";
        expect(snap).toContain(`{{BILLING_DB_ID_${other}}}`);
        expect(snap).toContain(`{{BROKER_REGISTRY_ID_${other}}}`);
        expect(r.out + r.err).not.toContain(DB);
        expect(r.out + r.err).not.toContain(REG);
        expect(existsSync(join(DIR, "wrangler.deploy.jsonc"))).toBe(false);
      });

    it("refuses a missing or malformed D1 or registry id", () => {
      for (const env of [
        {},
        { BROKER_REGISTRY_ID: REG },
        { BILLING_DB_ID: "", BROKER_REGISTRY_ID: REG },
        {
          BILLING_DB_ID: "0123456789abcdef0123456789abcdef",
          BROKER_REGISTRY_ID: REG,
        },
        { BILLING_DB_ID: DB.toUpperCase(), BROKER_REGISTRY_ID: REG },
        { BILLING_DB_ID: `${DB}/x`, BROKER_REGISTRY_ID: REG },
        { BILLING_DB_ID: "../../etc", BROKER_REGISTRY_ID: REG },
        { BILLING_DB_ID: DB },
        { BILLING_DB_ID: DB, BROKER_REGISTRY_ID: "" },
        { BILLING_DB_ID: DB, BROKER_REGISTRY_ID: DB },
        { BILLING_DB_ID: DB, BROKER_REGISTRY_ID: `${REG}/x` },
        { BILLING_DB_ID: DB, DIRECTORY_REGISTRY_ID: REG },
      ] as Record<string, string>[]) {
        const r = run(["billing", "staging"], env);
        expect(r.code).toBe(1);
        expect(r.log).toEqual([]);
      }
    });
  });

  describe("scheduler", () => {
    const DIR = join(root, "apps/scheduler");
    const DB = "0123abcd-4567-89ef-0123-456789abcdef";
    const OK = {
      PLATFORM_DB_ID: DB,
      EMAIL_ZONE_TAGS: `${REG},${"b".repeat(32)}`,
      EMAIL_DAILY_LIMIT: "3000",
      OPS_ALERT_EMAIL: "ops+alerts@example.com",
      OPS_ALERT_FROM: "alerts@mail.open-artifacts.app",
      SIGNUP_DAILY_CAP: "20",
      SIGNUPS_ENABLED: "false",
    };

    for (const env of ["staging", "prod"] as const)
      it(`${env}: deploys from apps/scheduler and fills its D1, quota and alert placeholders`, () => {
        const r = run(["scheduler", env], OK);
        expect(r.code).toBe(0);
        expect(r.log).toEqual([
          `pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env ${env}`,
          DIR,
          "copy-present",
        ]);
        const snap = readFileSync(r.snap, "utf8");
        const up = env.toUpperCase();
        expect(snap).toContain(`"ALERT_TO": "${OK.OPS_ALERT_EMAIL}"`);
        expect(snap).toContain(`"ALERT_FROM": "${OK.OPS_ALERT_FROM}"`);
        expect(snap).toContain('"SIGNUPS_ENABLED": "false"');
        expect(snap).toContain(`"database_id": "${DB}"`);
        expect(snap).not.toMatch(new RegExp(`\\{\\{[A-Z0-9_]*_${up}\\}\\}`));
        // Only this env's placeholders are filled.
        const other = env === "staging" ? "PROD" : "STAGING";
        expect(snap).toContain(`{{OPS_ALERT_EMAIL_${other}}}`);
        expect(snap).toContain(`{{OPS_ALERT_FROM_${other}}}`);
        expect(r.out + r.err).not.toContain(OK.OPS_ALERT_EMAIL);
        expect(existsSync(join(DIR, "wrangler.deploy.jsonc"))).toBe(false);
      });

    it("refuses a missing or malformed alert address (an email pattern, no sed syntax)", () => {
      for (const bad of [
        "",
        "ops",
        "ops@",
        "@example.com",
        "ops@example",
        "ops@example.com/x",
        "ops@exa&mple.com",
        "o\\ps@example.com",
        "ops @example.com",
        "a@b.com,c@d.com",
        "Ops <ops@example.com>",
        '"ops"@example.com',
        "{{OPS_ALERT_EMAIL_STAGING}}",
      ])
        for (const key of ["OPS_ALERT_EMAIL", "OPS_ALERT_FROM"]) {
          const r = run(["scheduler", "staging"], { ...OK, [key]: bad });
          expect(r.code).toBe(1);
          expect(r.log).toEqual([]);
        }
      for (const key of ["OPS_ALERT_EMAIL", "OPS_ALERT_FROM"]) {
        const { [key as keyof typeof OK]: _, ...rest } = OK;
        const r = run(["scheduler", "staging"], rest);
        expect(r.code).toBe(1);
        expect(r.log).toEqual([]);
      }
    });

    it("refuses a missing or malformed D1 id, zone list or limit", () => {
      for (const o of [
        { PLATFORM_DB_ID: "" },
        { PLATFORM_DB_ID: REG },
        { EMAIL_ZONE_TAGS: "" },
        { EMAIL_ZONE_TAGS: "abc" },
        { EMAIL_ZONE_TAGS: Array(11).fill(REG).join(",") },
        { EMAIL_DAILY_LIMIT: "0" },
        { EMAIL_DAILY_LIMIT: "1000000000" },
        { EMAIL_DAILY_LIMIT: "1e3" },
        { SIGNUP_DAILY_CAP: "" },
        { SIGNUP_DAILY_CAP: "0" },
        { SIGNUP_DAILY_CAP: "10000" },
        { SIGNUP_DAILY_CAP: "020" },
        { SIGNUPS_ENABLED: "" },
        { SIGNUPS_ENABLED: "1" },
        { SIGNUPS_ENABLED: "TRUE" },
        { SIGNUPS_ENABLED: "true " },
        { SIGNUPS_ENABLED: "yes" },
      ]) {
        const r = run(["scheduler", "staging"], { ...OK, ...o });
        expect(r.code).toBe(1);
        expect(r.log).toEqual([]);
      }
    });
  });

  describe("provisioner", () => {
    const DIR = join(root, "apps/provisioner");
    const DB = "0123abcd-4567-89ef-0123-456789abcdef";
    const ACCT = "a".repeat(32);
    const OK = {
      SIGNUP_DAILY_CAP: "20",
      WELCOME_FROM: "welcome@mail.open-artifacts.app",
      RELEASE_VERSION: "0.74.1",
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      SECRETS_STORE_ID: "c".repeat(32),
      PLATFORM_DB_ID: DB,
      SIGNUPS_ENABLED: "true",
    };
    /** A copy of the repo's wrapper beside a provisioner config of our own. */
    const tree = (config: string) => {
      const t = mkdtempSync(join(tmpdir(), "oa-deploy-tree-"));
      write(
        join(t, "scripts/ops/deploy-platform-worker.sh"),
        readFileSync(SCRIPT, "utf8"),
      );
      write(join(t, "apps/provisioner/wrangler.jsonc"), config);
      return join(t, "scripts/ops/deploy-platform-worker.sh");
    };
    const CONFIG = readFileSync(join(DIR, "wrangler.jsonc"), "utf8");

    for (const env of ["staging", "prod"] as const)
      it(`${env}: the wrapper fills and verifies provisioner placeholders`, () => {
        const r = run(["provisioner", env], OK);
        expect(r.code).toBe(0);
        expect(r.log).toEqual([
          `pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env ${env}`,
          DIR,
          "copy-present",
        ]);
        const snap = readFileSync(r.snap, "utf8");
        const up = env.toUpperCase();
        expect(snap).toContain('"SIGNUP_DAILY_CAP": "20"');
        expect(snap).toContain(`"WELCOME_FROM": "${OK.WELCOME_FROM}"`);
        expect(snap).toContain('"RELEASE_VERSION": "0.74.1"');
        expect(snap).toContain(`"ACCOUNT_ID": "${ACCT}"`);
        expect(snap).toContain(`"store_id": "${OK.SECRETS_STORE_ID}"`);
        expect(snap).toContain(`"database_id": "${DB}"`);
        expect(snap).toContain('"SIGNUPS_ENABLED": "true"');
        // No KV bindings: provision reaches KV over REST.
        expect(snap).not.toContain("kv_namespaces");
        expect(snap).not.toMatch(new RegExp(`\\{\\{[A-Z0-9_]*_${up}\\}\\}`));
        // Only this env's placeholders are filled.
        const other = env === "staging" ? "PROD" : "STAGING";
        expect(snap).toContain(`{{SIGNUP_DAILY_CAP_${other}}}`);
        expect(snap).toContain(`{{SECRETS_STORE_ID_${other}}}`);
        expect(r.out + r.err).not.toContain(OK.WELCOME_FROM);
        expect(r.out + r.err).not.toContain(OK.SECRETS_STORE_ID);
        expect(existsSync(join(DIR, "wrangler.deploy.jsonc"))).toBe(false);
      });

    it("refuses an unfilled or invalid value", () => {
      const bad: Record<string, string[]> = {
        SIGNUP_DAILY_CAP: ["", "0", "10000", "020", "1e3", "-1", "20 "],
        WELCOME_FROM: ["", "welcome", "a@b", "a@b.com/x", "W <a@b.com>"],
        RELEASE_VERSION: [
          "",
          "v0.74.1",
          "0.74",
          "0.74.1-rc.1",
          "01.2.3",
          "0.74.1/x",
          "latest",
        ],
        CLOUDFLARE_ACCOUNT_ID: ["", "abc", ACCT.toUpperCase(), `${ACCT}0`],
        SECRETS_STORE_ID: ["", DB, `${REG}/x`],
        PLATFORM_DB_ID: ["", REG, DB.toUpperCase()],
        SIGNUPS_ENABLED: ["", "1", "TRUE", "true ", "on", "false/x"],
      };
      for (const [key, values] of Object.entries(bad)) {
        for (const v of [...values, `{{${key}_STAGING}}`]) {
          const r = run(["provisioner", "staging"], { ...OK, [key]: v });
          expect(r.code, `${key}=${v}`).toBe(1);
          expect(r.log).toEqual([]);
        }
        const { [key as keyof typeof OK]: _, ...rest } = OK;
        const r = run(["provisioner", "staging"], { ...rest, [key]: "" });
        expect(r.code, `${key} unset`).toBe(1);
        expect(r.log).toEqual([]);
      }
    });

    it("refuses a placeholder the fills don't cover", () => {
      const script = tree(
        CONFIG.replace(
          '"OA_ENV": "staging",',
          '"OA_ENV": "staging", "EXTRA": "{{EXTRA_STAGING}}",',
        ),
      );
      const r = run(["provisioner", "staging"], OK, script);
      expect(r.code).toBe(1);
      expect(r.log).toEqual([]);
      expect(r.err).toContain("{{EXTRA_STAGING}}");
      expect(r.err).not.toContain(OK.SECRETS_STORE_ID);
    });

    it("a provisioner config binding another Worker's secret is refused", () => {
      for (const name of [
        "oa-s-billing-webhook-secret",
        "oa-p-provision-token",
        "oa-s-provision-token-2",
      ]) {
        const script = tree(
          CONFIG.replace(
            '"secret_name": "oa-s-provision-token"',
            `"secret_name": "oa-s-provision-token" }, { "binding": "X", "store_id": "{{SECRETS_STORE_ID_STAGING}}", "secret_name": "${name}"`,
          ),
        );
        const r = run(["provisioner", "staging"], OK, script);
        expect(r.code, name).toBe(1);
        expect(r.log).toEqual([]);
        expect(r.err).toMatch(/secret/);
      }
      // The repo's own config passes the same check (both envs).
      for (const env of ["staging", "prod"])
        expect(run(["provisioner", env], OK, tree(CONFIG)).code).toBe(0);
    });

    it("swapped tokens are refused: each env block binds its own env's token", () => {
      const swapped = tree(
        CONFIG.replace(
          '"secret_name": "oa-s-provision-token"',
          '"secret_name": "@S@"',
        )
          .replace(
            '"secret_name": "oa-p-provision-token"',
            '"secret_name": "oa-s-provision-token"',
          )
          .replace(
            '"secret_name": "@S@"',
            '"secret_name": "oa-p-provision-token"',
          ),
      );
      for (const env of ["staging", "prod"]) {
        const r = run(["provisioner", env], OK, swapped);
        expect(r.code, env).toBe(1);
        expect(r.log).toEqual([]);
        expect(r.err).toMatch(/block must bind/);
      }
    });

    it("a config that binds the provision token on any other target is refused", () => {
      const SCHED = readFileSync(
        join(root, "apps/scheduler/wrangler.jsonc"),
        "utf8",
      );
      const t = mkdtempSync(join(tmpdir(), "oa-deploy-tree-"));
      write(
        join(t, "scripts/ops/deploy-platform-worker.sh"),
        readFileSync(SCRIPT, "utf8"),
      );
      write(
        join(t, "apps/scheduler/wrangler.jsonc"),
        SCHED.replace(
          '"d1_databases"',
          '"secrets_store_secrets": [{ "binding": "T", "store_id": "x", "secret_name": "oa-s-provision-token" }], "d1_databases"',
        ),
      );
      const r = run(
        ["scheduler", "staging"],
        {
          PLATFORM_DB_ID: DB,
          EMAIL_ZONE_TAGS: REG,
          EMAIL_DAILY_LIMIT: "3000",
          OPS_ALERT_EMAIL: "ops@example.com",
          OPS_ALERT_FROM: "alerts@example.com",
          SIGNUP_DAILY_CAP: "20",
          SIGNUPS_ENABLED: "true",
        },
        join(t, "scripts/ops/deploy-platform-worker.sh"),
      );
      expect(r.code).toBe(1);
      expect(r.log).toEqual([]);
      expect(r.err).toMatch(/provision token/);
    });
  });
});
