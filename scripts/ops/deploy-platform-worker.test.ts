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
    for (const a of ["landing", "../auth-broker", "apps/auth-broker", ""]) {
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

  describe("dispatch and scheduler", () => {
    const UUID = "6ca9103e-507e-4541-b3bb-2485e699512b";
    const SCHED = {
      PLATFORM_DB_ID: UUID,
      EMAIL_ZONE_TAGS: `${REG},${REG}`,
      EMAIL_DAILY_LIMIT: "1000",
    };

    it("dispatch: deploys from apps/dispatch with its HOSTS id, for either env", () => {
      for (const env of ["staging", "prod"]) {
        const r = run(["dispatch", env], { HOSTS_KV_ID: REG });
        expect(r.code, env).toBe(0);
        expect(r.log).toEqual([
          `pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env ${env}`,
          join(root, "apps/dispatch"),
          "copy-present",
        ]);
        expect(readFileSync(r.snap, "utf8")).not.toContain(
          `{{HOSTS_KV_ID_${env.toUpperCase()}}}`,
        );
      }
      expect(
        existsSync(join(root, "apps/dispatch/wrangler.deploy.jsonc")),
      ).toBe(false);
    });

    it("scheduler: fills the D1 id, the zone tags and the daily limit", () => {
      const r = run(["scheduler", "prod"], SCHED);
      expect(r.code).toBe(0);
      const snap = readFileSync(r.snap, "utf8");
      expect(snap).toContain(`"database_id": "${UUID}"`);
      expect(snap).toContain(`"EMAIL_QUOTA_ZONES": "${REG},${REG}"`);
      expect(snap).toContain(`"EMAIL_DAILY_LIMIT": "1000"`);
      expect(snap).not.toMatch(/\{\{[A-Z0-9_]*_PROD\}\}/);
      expect(
        existsSync(join(root, "apps/scheduler/wrangler.deploy.jsonc")),
      ).toBe(false);
    });

    it("refuses malformed or missing values without deploying", () => {
      for (const [app, env] of [
        ["dispatch", { HOSTS_KV_ID: "" }],
        ["dispatch", { HOSTS_KV_ID: `${REG}/x` }],
        ["scheduler", { ...SCHED, PLATFORM_DB_ID: "not-a-uuid" }],
        ["scheduler", { ...SCHED, EMAIL_ZONE_TAGS: "" }],
        [
          "scheduler",
          { ...SCHED, EMAIL_ZONE_TAGS: Array(11).fill(REG).join(",") },
        ],
        ["scheduler", { ...SCHED, EMAIL_DAILY_LIMIT: "0" }],
        ["scheduler", { ...SCHED, EMAIL_DAILY_LIMIT: "1e9" }],
        ["scheduler", { ...SCHED, EMAIL_DAILY_LIMIT: "1234567890" }],
      ] as const) {
        const r = run([app, "prod"], env);
        expect(r.code, `${app} ${JSON.stringify(env)}`).toBe(1);
        expect(r.log).toEqual([]);
      }
    });
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

  describe("provisioner", () => {
    const DIR = join(root, "apps/provisioner");
    const DB = "0123abcd-4567-89ef-0123-456789abcdef";
    const ACCT = "a".repeat(32);
    const OK = {
      SIGNUP_DAILY_CAP: "20",
      WELCOME_FROM: "welcome@mail.open-artifacts.app",
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      SECRETS_STORE_ID: "c".repeat(32),
      PLATFORM_DB_ID: DB,
      SIGNUPS_ENABLED: "true",
    };
    /** A copy of the repo's wrapper beside an app config of our own. */
    const tree = (config: string, app = "provisioner") => {
      const t = mkdtempSync(join(tmpdir(), "oa-deploy-tree-"));
      write(
        join(t, "scripts/ops/deploy-platform-worker.sh"),
        readFileSync(SCRIPT, "utf8"),
      );
      write(join(t, `apps/${app}/wrangler.jsonc`), config);
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
        expect(snap).toContain(`"ACCOUNT_ID": "${ACCT}"`);
        expect(snap).toContain(`"store_id": "${OK.SECRETS_STORE_ID}"`);
        expect(snap).toContain(`"database_id": "${DB}"`);
        expect(snap).toContain('"SIGNUPS_ENABLED": "true"');
        // The release is a job argument (design v7 2.4), never a var.
        expect(snap).not.toContain("RELEASE_VERSION");
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

    it("SIGNUPS_ENABLED test-users is staging only", () => {
      const s = run(["provisioner", "staging"], {
        ...OK,
        SIGNUPS_ENABLED: "test-users",
      });
      expect(s.code).toBe(0);
      expect(readFileSync(s.snap, "utf8")).toContain(
        '"SIGNUPS_ENABLED": "test-users"',
      );
      const p = run(["provisioner", "prod"], {
        ...OK,
        SIGNUPS_ENABLED: "test-users",
      });
      expect(p.code).toBe(1);
      expect(p.log).toEqual([]);
      expect(
        run(["provisioner", "prod"], { ...OK, SIGNUPS_ENABLED: "false" }).code,
      ).toBe(0);
    });

    it("refuses an unfilled or invalid value", () => {
      const bad: Record<string, string[]> = {
        SIGNUP_DAILY_CAP: ["", "0", "10000", "020", "1e3", "-1", "20 "],
        WELCOME_FROM: ["", "welcome", "a@b", "a@b.com/x", "W <a@b.com>"],
        CLOUDFLARE_ACCOUNT_ID: ["", "abc", ACCT.toUpperCase(), `${ACCT}0`],
        SECRETS_STORE_ID: ["", DB, `${REG}/x`],
        PLATFORM_DB_ID: ["", REG, DB.toUpperCase()],
        SIGNUPS_ENABLED: [
          "",
          "1",
          "TRUE",
          "true ",
          "on",
          "false/x",
          "test-users ",
        ],
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

    it("a provisioner config binding another secret is refused", () => {
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

    it("a config that names the provision token on any other target is refused", () => {
      const SCHED = readFileSync(
        join(root, "apps/scheduler/wrangler.jsonc"),
        "utf8",
      );
      const script = tree(
        SCHED.replace(
          '"d1_databases"',
          '"secrets_store_secrets": [{ "binding": "T", "store_id": "x", "secret_name": "oa-s-provision-token" }], "d1_databases"',
        ),
        "scheduler",
      );
      const env = {
        PLATFORM_DB_ID: DB,
        EMAIL_ZONE_TAGS: REG,
        EMAIL_DAILY_LIMIT: "3000",
      };
      const r = run(["scheduler", "staging"], env, script);
      expect(r.code).toBe(1);
      expect(r.log).toEqual([]);
      expect(r.err).toMatch(/provision token/);
      // The same tree without the binding deploys.
      expect(
        run(["scheduler", "staging"], env, tree(SCHED, "scheduler")).code,
      ).toBe(0);
    });
  });

  describe("provisioning", () => {
    const DIR = join(root, "apps/provisioning");
    const DB = "0123abcd-4567-89ef-0123-456789abcdef";
    const KV = "d".repeat(32);
    const OK = {
      PLATFORM_DB_ID: DB,
      PROVISIONING_OAUTH_KV_ID: KV,
      GITHUB_REPOSITORY_ID: "1012345678",
    };
    const tree = (config: string) => {
      const t = mkdtempSync(join(tmpdir(), "oa-deploy-tree-"));
      write(
        join(t, "scripts/ops/deploy-platform-worker.sh"),
        readFileSync(SCRIPT, "utf8"),
      );
      write(join(t, "apps/provisioning/wrangler.jsonc"), config);
      return join(t, "scripts/ops/deploy-platform-worker.sh");
    };
    const CONFIG = readFileSync(join(DIR, "wrangler.jsonc"), "utf8");

    for (const env of ["staging", "prod"] as const)
      it(`${env}: fills the D1 id, the OAuth KV id and (staging) the repository id; none left`, () => {
        const r = run(["provisioning", env], OK);
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(r.log).toEqual([
          `pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env ${env}`,
          DIR,
          "copy-present",
        ]);
        const snap = readFileSync(r.snap, "utf8");
        const up = env.toUpperCase();
        expect(snap).toContain(`"database_id": "${DB}"`);
        expect(snap).toContain(`"id": "${KV}"`);
        expect(snap).not.toMatch(new RegExp(`\\{\\{[A-Z0-9_]*_${up}\\}\\}`));
        if (env === "staging")
          expect(snap).toContain('"OIDC_REPOSITORY_ID": "1012345678"');
        else expect(snap).toContain("{{GITHUB_REPOSITORY_ID_STAGING}}");
        expect(r.out + r.err).not.toContain(KV);
      });

    it("refuses a missing or malformed value without deploying", () => {
      const bad: Record<string, string[]> = {
        PLATFORM_DB_ID: ["", KV],
        PROVISIONING_OAUTH_KV_ID: ["", DB, KV.toUpperCase()],
        GITHUB_REPOSITORY_ID: ["", "0123", "12a", "1/2"],
      };
      for (const [key, values] of Object.entries(bad))
        for (const v of values) {
          const r = run(["provisioning", "staging"], { ...OK, [key]: v });
          expect(r.code, `${key}=${v}`).toBe(1);
          expect(r.log).toEqual([]);
        }
      // Prod needs no repository id.
      expect(
        run(["provisioning", "prod"], { ...OK, GITHUB_REPOSITORY_ID: "" }).code,
      ).toBe(0);
    });

    it("fails closed on any placeholder left for the env", () => {
      for (const env of ["staging", "prod"]) {
        const up = env.toUpperCase();
        const script = tree(
          CONFIG.replace(
            `"OA_ENV": "${env}",`,
            `"OA_ENV": "${env}", "EXTRA": "{{EXTRA_${up}}}",`,
          ),
        );
        const r = run(["provisioning", env], OK, script);
        expect(r.code, env).toBe(1);
        expect(r.log).toEqual([]);
        expect(r.err).toContain(`{{EXTRA_${up}}}`);
      }
    });

    it("refuses a provisioning config that names the provision token", () => {
      const script = tree(
        CONFIG.replace(
          '"kv_namespaces"',
          '"secrets_store_secrets": [{ "binding": "T", "store_id": "x", "secret_name": "oa-s-provision-token" }], "kv_namespaces"',
        ),
      );
      const r = run(["provisioning", "staging"], OK, script);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/provision token/);
      expect(r.log).toEqual([]);
    });
  });

  describe("inventory", () => {
    const DB = "0123abcd-4567-89ef-0123-456789abcdef";
    const OK = { PLATFORM_DB_ID: DB, HOSTS_KV_ID: "e".repeat(32) };
    const tree = (config: string) => {
      const t = mkdtempSync(join(tmpdir(), "oa-deploy-tree-"));
      write(
        join(t, "scripts/ops/deploy-platform-worker.sh"),
        readFileSync(SCRIPT, "utf8"),
      );
      write(join(t, "apps/inventory/wrangler.jsonc"), config);
      return join(t, "scripts/ops/deploy-platform-worker.sh");
    };
    const CONFIG = readFileSync(
      join(root, "apps/inventory/wrangler.jsonc"),
      "utf8",
    );
    // W8's OIDC vars pin the repository id per env.
    const OIDC = CONFIG.replace(
      /"name": "oa-(s|p)-inventory",/g,
      (m, p) =>
        `${m} "vars": { "OIDC_REPOSITORY_ID": "{{GITHUB_REPOSITORY_ID_${p === "s" ? "STAGING" : "PROD"}}}" },`,
    );

    it("fills the repository id when the config has its placeholder, and only then needs it", () => {
      expect(run(["inventory", "prod"], OK, tree(CONFIG)).code).toBe(0);
      for (const env of ["staging", "prod"]) {
        const r = run(
          ["inventory", env],
          { ...OK, GITHUB_REPOSITORY_ID: "42" },
          tree(OIDC),
        );
        expect(r.code, env).toBe(0);
        expect(readFileSync(r.snap, "utf8")).toContain(
          '"OIDC_REPOSITORY_ID": "42"',
        );
        expect(run(["inventory", env], OK, tree(OIDC)).code, env).toBe(1);
      }
    });
  });
});
