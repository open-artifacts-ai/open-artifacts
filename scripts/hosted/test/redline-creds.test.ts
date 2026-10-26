// oa:hosted redline-creds (P5): the red-line admin PAT and the hook key go
// into the redline-staging Environment over stdin only; earlier redline-*
// PATs are revoked after the new one is set. The install's API is a stub
// here (sessions, tokens, /healthz); Cloudflare is provision's fake.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { PUB, world } from "./world.ts";

const G = vi.hoisted(() => ({
  RELEASE_PUBKEY: { staging: "", prod: "" } as Record<string, string>,
}));
vi.mock("../../../packages/provision/src/internal/gates.ts", async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  return {
    ...m,
    PROD_UNLOCKED: true,
    FLOOR_MIN_SEQ: { staging: 1, prod: 1 },
    get RELEASE_PUBKEY() {
      return G.RELEASE_PUBKEY;
    },
  };
});
G.RELEASE_PUBKEY = { staging: PUB, prod: PUB };

type W = ReturnType<typeof world>;
const APP = (slug: string) => `${slug}.open-artifacts-staging.app`;
const CREDS = (id: string, ...extra: string[]) => [
  "redline-creds",
  "--env",
  "staging",
  "--install",
  id,
  "--confirm",
  id,
  ...extra,
];

async function install(
  w: W,
  slug = "rl-a",
  o: { testHooks?: boolean; domain?: string } = {},
) {
  const hooks = o.testHooks ?? true;
  const argv = [
    "create",
    "--env",
    "staging",
    "--slug",
    slug,
    "--owner",
    "owner@redline.test",
    "--to",
    "0.23.0",
    ...(hooks
      ? ["--test-hooks", "--var", `TEST_DOMAIN=${o.domain ?? "redline.test"}`]
      : []),
  ];
  expect(await main(argv, w.deps)).toBe(0);
  const id = w.parsed().find((l) => l.step === "create")?.data?.id as string;
  w.lines.length = 0;
  w.execs.length = 0;
  return id;
}

/** The hook key create wrote (0600) made visible to the CLI's file seam. */
function hookFile(w: W, slug = "rl-a", mode = 0o100600) {
  const path = join(
    w.home,
    ".open-artifacts",
    "hosted-staging",
    `${APP(slug)}-hook-key`,
  );
  const bytes = new Uint8Array(readFileSync(path));
  w.files.set(path, { bytes, info: { mode, uid: 501, isFile: true } });
  return new TextDecoder().decode(bytes).trim();
}

interface Api {
  calls: { method: string; path: string; auth: string; cookie: string }[];
  tokens: { id: string; label: string; token: string; revoked: boolean }[];
  secretsSet: { name: string; input: string; args: string[] }[];
  health: Record<string, unknown>;
  failDelete?: boolean;
}

/** The install's API for `slug` in front of provision's fake; gh is stubbed. */
function api(w: W, id: string, key: string, slug = "rl-a"): Api {
  const a: Api = {
    calls: [],
    tokens: [
      {
        id: "told1",
        label: "redline-202610250000",
        token: "x",
        revoked: false,
      },
      { id: "tother", label: "my laptop", token: "y", revoked: false },
    ],
    secretsSet: [],
    health: { ok: true, plan: "paid", testHooks: true, installId: id },
  };
  const COOKIE = "c0okie-value-only-the-cli-sees-123456";
  let n = 0;
  const inner = w.deps.fetch as typeof fetch;
  w.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname !== APP(slug)) return inner(input, init);
    const auth = req.headers.get("authorization") ?? "";
    const cookie = req.headers.get("cookie") ?? "";
    a.calls.push({ method: req.method, path: url.pathname, auth, cookie });
    const session = cookie === `__Host-oa_session=${COOKIE}`;
    const csrf = req.headers.get("x-oa-request") === "1";
    if (url.pathname === "/healthz") return Response.json(a.health);
    if (url.pathname === "/__test/session" && req.method === "POST") {
      const b = (await req.json()) as { email?: string; role?: string };
      if (auth !== `Bearer ${key}`)
        return new Response("Not found", { status: 404 });
      if (b.email !== "redline-admin@redline.test" || b.role !== "admin")
        return new Response("Not found", { status: 404 });
      return Response.json({ cookie: COOKIE });
    }
    if (url.pathname === "/api/v1/me") {
      const t = a.tokens.find(
        (x) => `Bearer ${x.token}` === auth && !x.revoked,
      );
      return t
        ? Response.json({ ok: true })
        : new Response(null, { status: 401 });
    }
    if (!session || !csrf) return new Response(null, { status: 401 });
    if (url.pathname === "/api/v1/tokens" && req.method === "GET")
      return Response.json(
        a.tokens
          .filter((t) => !t.revoked)
          .map(({ id: tid, label }) => ({ id: tid, label })),
      );
    if (url.pathname === "/api/v1/tokens" && req.method === "POST") {
      const b = (await req.json()) as { label?: string };
      const t = {
        id: `tnew${++n}`,
        label: b.label as string,
        token: `oa_pat_NeWPat${n}xyzABCdefGHJKmnpQRSTuvw`,
        revoked: false,
      };
      a.tokens.push(t);
      return Response.json({ ...t }, { status: 201 });
    }
    const m = /^\/api\/v1\/tokens\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === "DELETE") {
      if (a.failDelete)
        return new Response("boom owner@x.test", { status: 500 });
      const t = a.tokens.find((x) => x.id === m[1] && !x.revoked);
      if (!t) return new Response(null, { status: 404 });
      t.revoked = true;
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
  const exec = w.deps.execFile;
  w.deps.execFile = async (file, args, opt) => {
    if (file === "gh") {
      w.execs.push({ file, args, ...(opt?.input ? { input: opt.input } : {}) });
      a.secretsSet.push({
        name: args[2] as string,
        input: opt?.input ?? "",
        args,
      });
      return "";
    }
    return exec(file, args, opt);
  };
  return a;
}

describe("redline-creds", () => {
  it("sets the admin PAT and the hook key over stdin, then revokes only the earlier redline-* token", async () => {
    const w = world();
    const id = await install(w);
    const key = hookFile(w);
    const a = api(w, id, key);
    expect(await main(CREDS(id), w.deps)).toBe(0);
    const fresh = a.tokens.find((t) => t.id === "tnew1");
    expect(fresh?.label).toMatch(/^redline-\d{12}$/);
    expect(a.secretsSet.map((s) => [s.name, s.input])).toEqual([
      ["REDLINE_RL_A_PAT", fresh?.token],
      ["REDLINE_RL_A_HOOK_KEY", key],
    ]);
    for (const s of a.secretsSet)
      expect(s.args).toEqual([
        "secret",
        "set",
        s.name,
        "--env",
        "redline-staging",
        "-R",
        "open-artifacts-ai/open-artifacts",
      ]);
    expect(a.tokens.find((t) => t.id === "told1")?.revoked).toBe(true);
    expect(a.tokens.find((t) => t.id === "tother")?.revoked).toBe(false);
    expect(fresh?.revoked).toBe(false);
    // Set before revoke: CI never holds a dead token.
    const order = a.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("DELETE /api/v1/tokens/told1")).toBeGreaterThan(
      order.indexOf("GET /api/v1/me"),
    );
    expect(w.parsed().find((l) => l.step === "redline-creds")?.data).toEqual({
      slug: "rl-a",
      secrets: ["REDLINE_RL_A_PAT", "REDLINE_RL_A_HOOK_KEY"],
      revoked: 1,
    });
    expect(w.audit().map((r) => r.action)).toContain("cli.redline-creds.done");
  });

  it("no value reaches argv, output or the audit", async () => {
    const w = world();
    const id = await install(w);
    const key = hookFile(w);
    const a = api(w, id, key);
    expect(await main(CREDS(id), w.deps)).toBe(0);
    const pat = a.tokens.find((t) => t.id === "tnew1")?.token as string;
    const cookie = "c0okie-value-only-the-cli-sees-123456";
    const seen = [
      ...w.lines,
      ...w.errLines,
      ...w.execs.flatMap((e) => e.args),
      JSON.stringify(w.db().prepare("SELECT * FROM hosted_audit").all()),
    ].join("\n");
    for (const v of [pat, key, cookie]) {
      expect(v.length).toBeGreaterThan(16);
      expect(seen).not.toContain(v);
    }
  });

  it("refuses prod, CI, a missing --confirm and a mismatched one before any call", async () => {
    for (const [argv, ci] of [
      [
        [
          "redline-creds",
          "--env",
          "prod",
          "--install",
          "iaaaaaaaaaaa",
          "--confirm",
          "iaaaaaaaaaaa",
        ],
        false,
      ],
      [
        ["redline-creds", "--env", "staging", "--install", "iaaaaaaaaaaa"],
        false,
      ],
      [
        [
          "redline-creds",
          "--env",
          "staging",
          "--install",
          "iaaaaaaaaaaa",
          "--confirm",
          "ibbbbbbbbbbb",
        ],
        false,
      ],
    ] as const) {
      const w = world({ ci });
      expect(await main([...argv], w.deps)).toBe(1);
      expect(w.parsed().at(-1)).toMatchObject({
        step: "args",
        status: "error",
      });
      expect(w.cfCalls).toEqual([]);
      expect(w.execs).toEqual([]);
    }
    const w = world({ ci: true });
    w.files.set("/ci/token", {
      bytes: new TextEncoder().encode(w.fake.token),
      info: { mode: 0o100600, uid: 501, isFile: true },
    });
    w.deps.env.OA_HOSTED_TOKEN_FILE = "/ci/token";
    expect(await main(CREDS("iaaaaaaaaaaa"), w.deps)).toBe(1);
    expect(w.parsed().find((l) => l.step === "redline-creds")).toMatchObject({
      status: "error",
      message: "redline-creds runs on a laptop only",
    });
  });

  it("refuses an install that is not rl-a or rl-b, or has no test hooks, with no install call and no secret set", async () => {
    for (const [slug, hooks] of [
      ["acme", true],
      ["rl-b", false],
    ] as const) {
      const w = world();
      const id = await install(w, slug, { testHooks: hooks });
      const a = api(w, id, "k".repeat(40), slug);
      expect(await main(CREDS(id), w.deps)).toBe(1);
      expect(w.parsed().find((l) => l.step === "redline-creds")?.status).toBe(
        "error",
      );
      expect(a.calls).toEqual([]);
      expect(a.secretsSet).toEqual([]);
    }
  });

  it("refuses when /healthz is another install or hooks are off, before reading the key", async () => {
    for (const health of [
      { ok: true, testHooks: false },
      { ok: true, testHooks: true, installId: "izzzzzzzzzzz" },
    ]) {
      const w = world();
      const id = await install(w);
      const a = api(w, id, hookFile(w));
      a.health = health;
      expect(await main(CREDS(id), w.deps)).toBe(1);
      expect(a.calls.map((c) => c.path)).toEqual(["/healthz"]);
      expect(a.secretsSet).toEqual([]);
    }
  });

  it("refuses a hook key file that is a symlink or not 0600", async () => {
    for (const bad of ["symlink", "mode"] as const) {
      const w = world();
      const id = await install(w);
      const key = hookFile(w, "rl-a", bad === "mode" ? 0o100644 : 0o100600);
      if (bad === "symlink") for (const f of w.files.values()) f.symlink = true;
      const a = api(w, id, key);
      expect(await main(CREDS(id), w.deps)).toBe(1);
      expect(
        w.parsed().find((l) => l.step === "redline-creds")?.message,
      ).toMatch(bad === "mode" ? /must be mode 0600/ : /is a symlink/);
      expect(a.calls.map((c) => c.path)).toEqual(["/healthz"]);
    }
  });

  it("a thrown error that carries the cookie or the key is redacted in the output", async () => {
    const w = world();
    const id = await install(w);
    const key = hookFile(w);
    api(w, id, key);
    const inner = w.deps.fetch as typeof fetch;
    w.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === "/api/v1/tokens")
        throw new Error(
          `socket hang up; sent ${req.headers.get("cookie")} after ${key}`,
        );
      return inner(input, init);
    }) as typeof fetch;
    expect(await main(CREDS(id), w.deps)).toBe(1);
    const out = w.lines.join("\n");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("c0okie-value-only-the-cli-sees-123456");
    expect(out).not.toContain(key);
  });

  it("a failed revoke of an earlier token fails the run, after the new values are set, with no body text", async () => {
    const w = world();
    const id = await install(w);
    const a = api(w, id, hookFile(w));
    a.failDelete = true;
    expect(await main(CREDS(id), w.deps)).toBe(1);
    expect(a.secretsSet.map((s) => s.name)).toEqual([
      "REDLINE_RL_A_PAT",
      "REDLINE_RL_A_HOOK_KEY",
    ]);
    const msg = w.parsed().find((l) => l.step === "redline-creds")?.message;
    expect(msg).toBe("revoke earlier token told1: HTTP 500");
    expect(w.lines.join("\n")).not.toContain("owner@x.test");
  });
});
