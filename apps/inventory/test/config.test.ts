import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pinsFromEnv } from "../src/auth.ts";

const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
  name?: string;
  main?: string;
  env: Record<string, Record<string, unknown>>;
};
const REPO = "open-artifacts-ai/open-artifacts";
const ref = (f: string) => `${REPO}/.github/workflows/${f}@refs/heads/main`;
const OIDC = [
  "OIDC_AUDIENCE",
  "OIDC_ENVIRONMENT",
  "OIDC_JOB_WORKFLOW_REFS",
  "OIDC_REPOSITORY",
  "OIDC_REPOSITORY_ID",
];

describe("wrangler.jsonc", () => {
  it("deploys only per env: no top-level name or main", () => {
    expect(cfg.name).toBeUndefined();
    expect(cfg.main).toBeUndefined();
    expect(Object.keys(cfg.env).sort()).toEqual(["prod", "staging"]);
  });

  for (const [env, p] of [
    ["staging", "s"],
    ["prod", "p"],
  ] as const) {
    const e = cfg.env[env] as Record<string, unknown>;
    const up = env.toUpperCase();

    it(`${env}: exactly PLATFORM_DB, HOSTS and the five OIDC vars; no secrets`, () => {
      expect(e.name).toBe(`oa-${p}-inventory`);
      expect(e.main).toBe("src/index.ts");
      expect(e.d1_databases).toEqual([
        {
          binding: "PLATFORM_DB",
          database_name: `oa-${p}-platform`,
          database_id: `{{PLATFORM_DB_ID_${up}}}`,
        },
      ]);
      expect(e.kv_namespaces).toEqual([
        { binding: "HOSTS", id: `{{HOSTS_KV_ID_${up}}}` },
      ]);
      expect(Object.keys(e.vars as object).sort()).toEqual(OIDC);
      for (const k of [
        "r2_buckets",
        "services",
        "durable_objects",
        "secrets_store_secrets",
        "secrets",
        "routes",
        "route",
        "triggers",
        "queues",
        "ai",
        "analytics_engine_datasets",
        "observability",
        "workflows",
      ])
        expect(e, k).not.toHaveProperty(k);
      expect(raw).not.toMatch(/KEY"|TOKEN|SECRET/);
      expect(e.workers_dev).toBe(true);
      expect(e.preview_urls).toBe(false);
    });

    it(`${env}: the vars parse to pins (none empty) for redline-staging`, () => {
      const v = e.vars as Record<string, string>;
      const pins = pinsFromEnv(v);
      expect(pins).not.toBeNull();
      // Design 6.3: the audience is the https URI form.
      expect(pins?.audience).toBe(`https://oa-${p}-inventory`);
      expect(pins?.repository).toBe(REPO);
      expect(v.OIDC_REPOSITORY_ID).toBe(`{{GITHUB_REPOSITORY_ID_${up}}}`);
      expect(pins?.environment).toBe("redline-staging");
      const refs =
        env === "prod"
          ? [ref("redline-staging.yml"), ref("prodclean-monitor.yml")]
          : [ref("redline-staging.yml")];
      expect(pins?.jobWorkflowRefs).toEqual(refs);
    });
  }
});
