import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTED_DOMAINS, NAMESPACES, platformNames } from "@oa/provision";
import { describe, expect, it } from "vitest";

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");
// Strip // and /* */ comments outside strings.
const strip = (s: string) =>
  s.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_m, str) => str ?? "",
  );
// biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
const cfg: any = JSON.parse(
  strip(readFileSync(join(app, "wrangler.jsonc"), "utf8")),
);
const ENVS = ["staging", "prod"] as const;

/** Keys that would attach the Worker to a hostname from the repo config. */
const ROUTING = ["route", "routes", "custom_domain", "custom_domains"];

describe("wrangler.jsonc", () => {
  it("names each env's Worker, namespace and HOSTS binding", () => {
    expect(Object.keys(cfg.env).sort()).toEqual(["prod", "staging"]);
    for (const env of ENVS) {
      const e = cfg.env[env];
      expect(e.name).toBe(platformNames(env).dispatch);
      expect(e.main).toBe("src/index.ts");
      const zone = HOSTED_DOMAINS[env].app;
      expect(e.vars).toEqual({
        OA_ENV: env,
        AUTH_BROKER_ORIGIN: `https://auth.${zone}`,
        DIRECTORY_BROKER_ORIGIN: `https://directory.${zone}`,
      });
      // The gate's bindings: this env's two brokers, never the other env's.
      expect(e.services).toEqual([
        { binding: "AUTH_BROKER", service: platformNames(env).broker },
        {
          binding: "DIRECTORY_BROKER",
          service: platformNames(env).directoryBroker,
        },
      ]);
      expect(e.dispatch_namespaces).toEqual([
        { binding: "DISPATCHER", namespace: NAMESPACES[env] },
      ]);
      // One placeholder per env, so filling one env can't bind the other's HOSTS.
      expect(e.kv_namespaces).toEqual([
        { binding: "HOSTS", id: `{{HOSTS_KV_ID_${env.toUpperCase()}}}` },
      ]);
      // Workers Logs would record full URLs; the Worker logs the host only.
      expect(e.observability).toEqual({ enabled: false });
    }
    expect(platformNames("staging").hosts).toBe("oa-s-hosts");
    expect(platformNames("prod").hosts).toBe("oa-p-hosts");
  });

  it("has no routes, custom domains or workers.dev, at the top or in any env", () => {
    for (const c of [cfg, ...ENVS.map((e) => cfg.env[e])]) {
      for (const k of ROUTING) expect(c).not.toHaveProperty(k);
      expect(c.workers_dev).toBe(false);
      expect(c.preview_urls).toBe(false);
    }
    expect(JSON.stringify(cfg)).not.toMatch(/custom_domain|"pattern"|zone_/);
  });

  it("has no top-level name, bindings or vars (a deploy without --env can't run)", () => {
    for (const k of [
      "name",
      "main",
      "vars",
      "kv_namespaces",
      "dispatch_namespaces",
      "services",
    ])
      expect(cfg).not.toHaveProperty(k);
  });
});

describe("@oa/provision/names", () => {
  it("resolves to the source under workerd, so a deploy never bundles a stale dist", () => {
    const pkg = JSON.parse(
      readFileSync(join(app, "../../packages/provision/package.json"), "utf8"),
    );
    expect(pkg.exports["./names"].workerd).toBe("./src/names.ts");
    expect(Object.keys(pkg.exports["./names"])[1]).toBe("workerd");
  });
});

const wrangler = (args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", ...args], {
    cwd: app,
    stdio: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });

describe("bundle", () => {
  it("wrangler deploy without --env is refused", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-dispatch-"));
    expect(() => wrangler(["--outdir", out])).toThrow(
      /name of your worker|entry-point/,
    );
  });

  it("wrangler deploy --name without --env is refused too (no top-level main)", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-dispatch-"));
    expect(() =>
      wrangler(["--name", platformNames("prod").dispatch, "--outdir", out]),
    ).toThrow(/entry-point/);
  });

  it("wrangler deploy --dry-run is under 50 KB per env", () => {
    for (const env of ENVS) {
      const out = mkdtempSync(join(tmpdir(), "oa-dispatch-"));
      wrangler(["--env", env, "--outdir", out]);
      const bytes = readdirSync(out)
        .filter((f) => f.endsWith(".js"))
        .reduce((n, f) => n + statSync(join(out, f)).size, 0);
      console.log(`dispatch bundle (${env}): ${bytes} bytes`);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(50 * 1024);
    }
  });
});
