import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { core, ROOT, STATE } from "./fakes.ts";

const state = {
  name: "acme",
  accountId: "acc1",
  appHost: "app.example.com",
  contentHost: "c.example.com",
  d1Id: "d1-uuid",
  r2Bucket: "acme",
  kvId: "kv-id",
  accessAppId: "app-uuid",
  emailDomain: "mail.example.com",
};

function setup(
  files: Record<string, string> = { [STATE]: JSON.stringify(state) },
) {
  const calls: string[] = [];
  const c = core({
    files,
    env: { HOME: "/home/u" },
    fetch: (async (i: unknown, init?: RequestInit) => {
      calls.push(`fetch ${init?.method ?? "GET"} ${String(i)}`);
      throw new Error("no network in a dry run");
    }) as typeof fetch,
    exec: async (cmd, args) => {
      calls.push(`exec ${cmd} ${args.join(" ")}`);
      throw new Error("no process in a dry run");
    },
  });
  return { ...c, calls };
}

describe("--uninstall --check", () => {
  it("lists every resource in a safe order and makes no calls", async () => {
    const w = setup();
    expect(await run(["--uninstall", "--check"], w.deps, ROOT)).toBe(0);
    const out = w.lines.join("\n");
    expect(w.calls).toEqual([]);
    expect(w.state()).toEqual(state);
    const at = (s: string) => out.indexOf(s);
    for (const s of [
      "Access app: acme (app-uuid)",
      "mail.example.com",
      "app.example.com, c.example.com",
      "wrangler delete --name acme",
      "kv namespace delete --namespace-id kv-id",
      "d1 delete acme",
      "r2 bucket delete acme",
      "state.json",
    ])
      expect(at(s), s).toBeGreaterThan(-1);
    expect(at("Access app")).toBeLessThan(at("wrangler delete"));
    expect(at("wrangler delete")).toBeLessThan(at("d1 delete"));
    expect(at("d1 delete")).toBeLessThan(at("state.json"));
    expect(out).toContain("DESTROYS DATA");
  });

  it("--json gives items and still changes nothing", async () => {
    const w = setup();
    expect(await run(["--uninstall", "--check", "--json"], w.deps, ROOT)).toBe(
      0,
    );
    const r = JSON.parse(w.lines.at(-1) as string);
    expect(r.data.items.map((i: { kind: string }) => i.kind)).toContain(
      "D1 database",
    );
    expect(w.calls).toEqual([]);
  });

  it("lists only token files that exist", async () => {
    const f = "/home/u/.open-artifacts/acme-cloudflare-token";
    const w = setup({ [STATE]: JSON.stringify(state) });
    w.files.set(f, "tok");
    await run(["--uninstall", "--check"], w.deps, ROOT);
    expect(w.lines.join("\n")).toContain(f);
    expect(w.lines.join("\n")).not.toContain("acme-access-token");
  });

  it("refuses without --check and with no state or name", async () => {
    const w = setup();
    expect(await run(["--uninstall"], w.deps, ROOT)).toBe(1);
    const n = setup({});
    expect(await run(["--uninstall", "--check"], n.deps, ROOT)).toBe(1);
    expect(w.calls).toEqual([]);
    expect(n.calls).toEqual([]);
  });

  it("with no state and --name, lists names and a KV find-id step", async () => {
    const n = setup({});
    expect(await run(["--uninstall", "--check", "--name", "foo"], n.deps, ROOT)).toBe(0);
    const out = n.lines.join("\n");
    expect(out).toContain("d1 delete foo");
    expect(out).toContain("r2 bucket delete foo");
    expect(out).toContain("foo-oauth");
    expect(out).toContain("kv namespace list");
    expect(n.calls).toEqual([]);
  });

  it("refuses a --name that differs from the saved name, naming both", async () => {
    const n = setup();
    expect(await run(["--uninstall", "--check", "--name", "other"], n.deps, ROOT)).toBe(1);
    expect(n.lines.join("\n")).toMatch(/other.*acme/);
    expect(n.calls).toEqual([]);
  });

  it("lists an orphaned Access app, the full email records and wrangler.jsonc", async () => {
    const n = setup({
      [STATE]: JSON.stringify({ ...state, pendingAccessAppId: "orphan-1" }),
    });
    await run(["--uninstall", "--check"], n.deps, ROOT);
    const out = n.lines.join("\n");
    expect(out).toContain("orphan-1");
    expect(out).toContain("cf-bounce._domainkey.mail.example.com");
    expect(out).toContain("_dmarc.mail.example.com only if onboarding created it");
    expect(out).toContain("apps/server/wrangler.jsonc");
    expect(out).toContain("Open Artifacts – everyone");
    expect(out).toContain("d1 export acme --remote --output backup.sql");
  });
});
