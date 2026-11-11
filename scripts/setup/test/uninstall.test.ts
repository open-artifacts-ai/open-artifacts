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
  });
});
