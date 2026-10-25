// A Google-only install (AUTH_PROVIDERS without access) end to end: no step
// requires or adds ACCESS_TEAM_DOMAIN, ACCESS_CLIENT_ID or
// ACCESS_CLIENT_SECRET, and nothing calls the Access API. Access installs
// keep requiring them.
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { stripComments } from "../src/steps/resources.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);
const deployedVars = (w: W) =>
  JSON.parse(stripComments(w.deployed() ?? "{}")).vars ?? {};
const GOOGLE_ONLY = [
  ...["--auth-providers", "google"],
  ...["--auth-domains", "example.com"],
  ...["--google-client-id", "123-abc.apps.googleusercontent.com"],
];
/** Every Access API request from here on. */
const accessCalls = (w: W) => {
  const seen: string[] = [];
  const inner = w.deps.fetch;
  w.deps.fetch = (input, init) => {
    const url = String(input);
    if (/\/access\//.test(url) || /cloudflareaccess\.com/.test(url))
      seen.push(`${init?.method ?? "GET"} ${url}`);
    return inner(input, init);
  };
  return seen;
};
const ACCESS_VARS = ["ACCESS_TEAM_DOMAIN", "ACCESS_CLIENT_ID"];

/**
 * Prod after the cutover: installed with Access, switched to Google only,
 * the Access app deleted, and its secret and vars gone from the Worker.
 * CI is stateless.
 */
const cutOver = async () => {
  const opts: NonNullable<Parameters<typeof world>[0]> = {};
  const w = world(opts);
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  expect(await run([...HOSTS, ...GOOGLE_ONLY], w.deps, ROOT)).toBe(0);
  w.apps.splice(0);
  opts.hideSecrets = ["ACCESS_CLIENT_SECRET"];
  w.files.delete(STATE);
  w.lines.length = 0;
  w.ops.length = 0;
  return w;
};

describe("Google only (access not in AUTH_PROVIDERS)", () => {
  it("--upgrade end to end, preflight through deploy: passes with ACCESS_* empty and adds none", async () => {
    const w = await cutOver();
    const calls = accessCalls(w);
    await run([...HOSTS, "--check", "--strict", "--upgrade"], w.deps, ROOT);
    expect(line(w, "access").status).toBe("done");
    w.lines.length = 0;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").status).toBe("ok");
    expect(line(w, "healthcheck").status).toBe("ok");
    expect(line(w, "healthcheck").message).not.toContain("OIDC");
    expect(line(w, "selftest").status).toBe("ok");
    expect(w.ops).toContain("deploy");
    expect(w.ops).not.toContain("put ACCESS_CLIENT_SECRET");
    const vars = deployedVars(w);
    for (const k of ACCESS_VARS) expect(vars[k] ?? "").toBe("");
    expect(vars.AUTH_PROVIDERS).toBe("google");
    expect(calls).toEqual([]);
  });
});

describe("Google only: prereqs", () => {
  it("with an OA_ACCESS_TOKEN set (no flag): passes, and nothing is written to Access", async () => {
    const w = await cutOver();
    w.deps.env.OA_ACCESS_TOKEN = "acc-token";
    const calls = accessCalls(w);
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    // Prereqs may still probe the token's read permissions; nothing else.
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(w.ops.filter((o) => /polic|apps/i.test(o))).toEqual([]);
  });

  it("a fresh Google-only install (--auth-providers google) never asks for or probes the Access token", async () => {
    const w = world();
    const calls = accessCalls(w);
    await run([...HOSTS, ...GOOGLE_ONLY, "--check"], w.deps, ROOT);
    const issues = JSON.stringify(line(w, "prereqs") ?? {});
    expect(issues).not.toMatch(/OA_ACCESS_TOKEN|access token/i);
    expect(calls).toEqual([]);
  });
});

describe("Access installs: as before", () => {
  it("--upgrade without the Access vars still refuses to deploy", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    w.apps.splice(0);
    w.files.delete(STATE);
    w.lines.length = 0;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(line(w, "access").message).toContain(
      "Access app open-artifacts not found",
    );
  });

  it("a missing ACCESS_CLIENT_SECRET still refuses the deploy", async () => {
    const opts: NonNullable<Parameters<typeof world>[0]> = {};
    const w = world(opts);
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    opts.hideSecrets = ["ACCESS_CLIENT_SECRET"];
    w.lines.length = 0;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(JSON.stringify(w.lines)).toContain("ACCESS_CLIENT_SECRET");
  });

  it("a healthy Access install upgrades and keeps its Access vars and OIDC check", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    w.lines.length = 0;
    const calls = accessCalls(w);
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    const vars = deployedVars(w);
    expect(vars.ACCESS_TEAM_DOMAIN).toBe("team.cloudflareaccess.com");
    expect(vars.ACCESS_CLIENT_ID).toBe("cid-new");
    expect(line(w, "healthcheck").message).toContain("OIDC discovery ok");
    expect(calls.length).toBeGreaterThan(0);
  });
});
