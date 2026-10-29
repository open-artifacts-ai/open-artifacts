import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

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

const run = (args: string[], env: Record<string, string> = {}) => {
  const sb = sandbox({ pnpm });
  const snap = join(sb.dir, "snap.jsonc");
  const r = sb.run(["bash", SCRIPT, ...args], {
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
    const IDS = { BILLING_DB_ID: DB, BROKER_REGISTRY_ID: REG };
    const PRICES = {
      STRIPE_PRICE_TEAM: "price_1TeamAbc",
      STRIPE_PRICE_BUSINESS: "price_1BizXyz",
    };

    for (const env of ["staging", "prod"] as const)
      it(`${env}: deploys from apps/billing with exact argv and fills its D1 and registry ids`, () => {
        const r = run(["billing", env], { ...PRICES, ...IDS });
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
        expect(snap).toContain(
          `"STRIPE_PRICE_TEAM": "${PRICES.STRIPE_PRICE_TEAM}"`,
        );
        expect(snap).toContain(
          `"STRIPE_PRICE_BUSINESS": "${PRICES.STRIPE_PRICE_BUSINESS}"`,
        );
        expect(snap).not.toMatch(new RegExp(`\\{\\{[A-Z0-9_]*_${up}\\}\\}`));
        // Only this env's placeholders are filled.
        const other = env === "staging" ? "PROD" : "STAGING";
        expect(snap).toContain(`{{BILLING_DB_ID_${other}}}`);
        expect(snap).toContain(`{{BROKER_REGISTRY_ID_${other}}}`);
        expect(snap).toContain(`{{STRIPE_PRICE_TEAM_${other}}}`);
        expect(snap).toContain(`{{STRIPE_PRICE_BUSINESS_${other}}}`);
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
        const r = run(["billing", "staging"], { ...PRICES, ...env });
        expect(r.code).toBe(1);
        expect(r.log).toEqual([]);
      }
    });

    it("refuses a missing or malformed price id", () => {
      for (const p of [
        {},
        { STRIPE_PRICE_TEAM: PRICES.STRIPE_PRICE_TEAM },
        { STRIPE_PRICE_BUSINESS: PRICES.STRIPE_PRICE_BUSINESS },
        { ...PRICES, STRIPE_PRICE_TEAM: "" },
        { ...PRICES, STRIPE_PRICE_TEAM: "prod_1Abc" },
        { ...PRICES, STRIPE_PRICE_TEAM: "price_1Abc/x" },
        { ...PRICES, STRIPE_PRICE_BUSINESS: "price_" },
        { ...PRICES, STRIPE_PRICE_BUSINESS: "price_1Abc&x" },
        { ...PRICES, STRIPE_PRICE_BUSINESS: "price_1Abc x" },
      ] as Record<string, string>[]) {
        const r = run(["billing", "staging"], { ...IDS, ...p });
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
      ]) {
        const r = run(["scheduler", "staging"], { ...OK, ...o });
        expect(r.code).toBe(1);
        expect(r.log).toEqual([]);
      }
    });
  });
});
