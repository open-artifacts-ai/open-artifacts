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

    for (const env of ["staging", "prod"] as const)
      it(`${env}: deploys from apps/billing with exact argv and fills its D1 id`, () => {
        const r = run(["billing", env], { BILLING_DB_ID: DB });
        expect(r.code).toBe(0);
        expect(r.log).toEqual([
          `pnpm exec wrangler deploy -c wrangler.deploy.jsonc --env ${env}`,
          DIR,
          "copy-present",
        ]);
        const snap = readFileSync(r.snap, "utf8");
        const up = env.toUpperCase();
        expect(snap).toContain(`"database_id": "${DB}"`);
        expect(snap).not.toContain(`{{BILLING_DB_ID_${up}}}`);
        // Only this env's placeholder is filled.
        const other = env === "staging" ? "PROD" : "STAGING";
        expect(snap).toContain(`{{BILLING_DB_ID_${other}}}`);
        expect(r.out + r.err).not.toContain(DB);
        expect(existsSync(join(DIR, "wrangler.deploy.jsonc"))).toBe(false);
      });

    it("refuses a missing or malformed D1 id, or another app's variable", () => {
      for (const env of [
        {},
        { BILLING_DB_ID: "" },
        { BILLING_DB_ID: "0123456789abcdef0123456789abcdef" },
        { BILLING_DB_ID: DB.toUpperCase() },
        { BILLING_DB_ID: `${DB}/x` },
        { BILLING_DB_ID: "../../etc" },
        { BROKER_REGISTRY_ID: REG },
      ] as Record<string, string>[]) {
        const r = run(["billing", "staging"], env);
        expect(r.code).toBe(1);
        expect(r.log).toEqual([]);
      }
    });
  });
});
