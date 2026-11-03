// #1008 PR1: the update kind's two operations on fake-cf, with a fake of the
// install's /healthz and copy route, checked against apps/server's
// mcp/oauth-copy.ts: off or a wrong key is a reasonless 404 (the rate limit
// too), `[]` is 404 bad_input, a page is the counts plus `backfilled`, and
// not_dual and markers are 404 reasons once the key verifies. Before it, a
// markers refusal is the 503 the respond hook injects here. The route itself
// runs in oauth-store-real.test.ts. Each install is made by ProvisionInstall
// first.
import { NAMESPACES } from "@oa/provision";
import { OAUTH_MODE_LIVE_ACTION } from "@oa/shared/provisioning";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import { runManage } from "../../src/manage.js";
import { COPY_MAX_PAGES } from "../../src/oauth-store.js";
import { runCreate } from "../../src/workflow.js";
import {
  ENV,
  event,
  seedCreate,
  seedJob,
  stepRunner,
  ulid,
  V1,
  V2,
  type World,
  world,
} from "./world.js";

vi.mock(
  "../../../../packages/provision/src/internal/gates.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../packages/provision/src/internal/gates.js")
    >()),
    get RELEASE_PUBKEY() {
      return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
    },
  }),
);

const KEY = "OAUTH_COPY_KEY";
const MIN = 60_000;
const CURSOR_A = "gen-11111111.kv-cursor-secret-a";
const CURSOR_B = "gen-11111111.kv-cursor-secret-b";

type Page = {
  kvKeys: number;
  copied: number;
  skippedExpiring: number;
  d1Rows: number | null;
  nextCursor: string | null;
  restarted: boolean;
};
const page = (o: Partial<Page> = {}): Page => ({
  kvKeys: 800,
  copied: 700,
  skippedExpiring: 100,
  d1Rows: null,
  nextCursor: null,
  restarted: false,
  ...o,
});
const THREE_PAGES = [
  page({ nextCursor: CURSOR_A }),
  page({ nextCursor: CURSOR_B }),
  page({ kvKeys: 5, copied: 4, skippedExpiring: 1, d1Rows: 1604 }),
];

let w: World;
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  w = await world();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  info = vi.spyOn(console, "log").mockImplementation(() => {});
});

async function active(version?: string) {
  const s = seedCreate(w, {
    slug: `o${Math.random().toString(36).slice(2, 8)}`,
    ...(version ? { version } : {}),
  });
  await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
  expect(w.job(s.jobId)?.status).toBe("done");
  return s.installId;
}

const scriptOf = (id: string) => {
  const s = w.fake.script(NAMESPACES[ENV], `oa-s-${id}`);
  if (!s) throw new Error("no script");
  return s;
};
const plain = (id: string, name: string) =>
  (
    scriptOf(id).metadata.bindings.find(
      (b: { name: string }) => b.name === name,
    ) as { text?: string } | undefined
  )?.text;

/** The install as the contract describes it. */
function install(
  id: string,
  o: {
    pages?: Page[];
    backfilled?: boolean;
    off?: number | null;
    /** The mode /healthz reports, over the binding. */
    mode?: () => string | undefined;
    /** Probes that still miss the key after the put. */
    staleProbes?: number;
    /** Per call: a Response overrides the route. */
    respond?: (call: Call, n: number) => Response | undefined;
    afterLast?: (s: { backfilled: boolean }) => void;
  } = {},
) {
  const state = { backfilled: o.backfilled ?? false };
  const calls: Call[] = [];
  const pages = [...(o.pages ?? THREE_PAGES)];
  const script = `oa-s-${id}`;
  let probes = 0;
  w.fake.health = (s) => {
    const version = (s.metadata.tags as string[])
      .find((t: string) => /^v\d/.test(t))
      ?.slice(1);
    const b = s.metadata.bindings.find(
      (x: { name: string }) => x.name === "OAUTH_STORE",
    ) as { text?: string } | undefined;
    return {
      ok: true,
      plan: "paid",
      version,
      installId: id,
      oauthStore: {
        mode: o.mode?.() ?? b?.text ?? "kv",
        backfilled: state.backfilled,
        kvWritesOffSince: o.off ?? null,
      },
    };
  };
  const real = w.env.DISPATCHER;
  w.env.DISPATCHER = {
    get: (name: string) => ({
      fetch: async (req: Request) => {
        const u = new URL(req.url);
        if (name !== script || u.pathname !== "/__oa/oauth-store/copy")
          return real.get(name).fetch(req);
        const body = await req.text();
        const call: Call = {
          at: w.clock.t,
          auth: req.headers.get("authorization") ?? "",
          body,
        };
        calls.push(call);
        const forced = o.respond?.(call, calls.length);
        if (forced) return forced;
        const key = scriptOf(id).secrets.get(KEY);
        const none = () => new Response(null, { status: 404 });
        if (!key || call.auth !== `Bearer ${key}`) return none();
        if (body === "[]") {
          if (probes++ < (o.staleProbes ?? 0)) return none();
          return refusal("bad_input");
        }
        const next = pages.shift();
        if (!next) throw new Error("the job asked for more pages than exist");
        if (next.nextCursor === null) {
          state.backfilled = true;
          o.afterLast?.(state);
        }
        return Response.json({ ...next, backfilled: !next.nextCursor });
      },
    }),
  } as unknown as DispatchNamespace;
  return { state, calls, pages };
}
type Call = { at: number; auth: string; body: string };
const refusal = (reason: string) =>
  Response.json(
    { error: { code: "not_found", message: "Not found", details: { reason } } },
    { status: 404 },
  );
const keyBodies = (calls: Call[]) => calls.map((c) => c.body);

/** An agent_tokens row of `kind`; its id. */
function agentToken(kind: "oauth" | "oat"): string {
  const id = ulid();
  const oauth = kind === "oauth";
  w.db
    .prepare(
      `INSERT INTO agent_tokens (id, kind, token_hash, session_hash, admin_email, label, scopes, client_id, oauth_user, created_at, expires_at)
VALUES (?, ?, ?, 'sh', 'a@example.com', 'x', '["installs:write"]', ?, ?, 1, 9)`,
    )
    .run(
      id,
      kind,
      oauth ? null : `hash-${id}`,
      oauth ? "client" : null,
      oauth ? "adm_x" : null,
    );
  return id;
}

/** Runs a job to its end; the failure, if any, as the engine's error. */
async function run(
  args: Record<string, unknown>,
  installId: string,
  o: Parameters<typeof seedJob>[1] extends infer T
    ? Partial<T> & {
        twice?: boolean;
        onStep?: (n: string) => void;
        /** The job's agent_tokens row; null: the job has no token_id. */
        grant?: "oauth" | "oat" | null;
      }
    : never = {},
) {
  const id = seedJob(w, {
    kind: "update",
    installId,
    args,
    actor: "token",
    ...o,
  } as Parameters<typeof seedJob>[1]);
  const grant = o.grant === undefined ? "oauth" : o.grant;
  if (grant !== null)
    w.db
      .prepare("UPDATE jobs SET token_id = ? WHERE id = ?")
      .run(agentToken(grant), id);
  const r = stepRunner(w.clock, { twice: o.twice, onStep: o.onStep });
  const error = await runManage(w.ctx, event(id), r.step).then(
    () => null,
    (x: unknown) => x as Error,
  );
  return { id, error, log: r.log, job: w.job(id) as Record<string, unknown> };
}
const setMode = (mode: string) => ({ vars: { OAUTH_STORE: mode } });
const COPY = { oauthCopy: true };

/** dual live on the install, verified long enough ago for a copy. */
async function dual(id: string, o: Parameters<typeof install>[1] = {}) {
  const f = install(id, o);
  const r = await run(setMode("dual"), id);
  expect(r.job.status).toBe("done");
  w.clock.t += 2 * MIN;
  return f;
}

const auditOf = (id: string) =>
  w.all<{ action: string; detail: string }>(
    "SELECT action, detail FROM hosted_audit WHERE install_id = ? ORDER BY id",
    id,
  );
const secrecy = (values: string[]) => {
  const dump = JSON.stringify({
    jobs: w.all("SELECT * FROM jobs"),
    audit: w.all("SELECT * FROM hosted_audit"),
    logs: [...warn.mock.calls, ...info.mock.calls],
  });
  for (const v of values) expect(dump).not.toContain(v);
};
const bearer = (c: Call) => c.auth.replace(/^Bearer /, "");

describe("update: set OAUTH_STORE (R29)", () => {
  it("kv to dual: the var goes up, /healthz shows it, the install keeps it, and when it went live is recorded", async () => {
    const id = await active();
    install(id);
    const r = await run(setMode("dual"), id);
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "done", step: "done" });
    expect(plain(id, "OAUTH_STORE")).toBe("dual");
    expect(JSON.parse(w.install(id)?.vars as string).OAUTH_STORE).toBe("dual");
    const live = auditOf(id).filter((a) => a.action === OAUTH_MODE_LIVE_ACTION);
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]?.detail as string)).toMatchObject({
      mode: "dual",
    });
    expect(r.log.map((l) => l.name)).toEqual(
      expect.arrayContaining(["precheck", "update_vars", "mode_live"]),
    );
  });

  it("keeps the install's other vars", async () => {
    const id = await active();
    install(id);
    const before = JSON.parse(w.install(id)?.vars as string);
    await run(setMode("dual"), id);
    expect(JSON.parse(w.install(id)?.vars as string)).toEqual({
      ...before,
      OAUTH_STORE: "dual",
    });
  });

  it("the mode survives an upgrade and a rollback", async () => {
    const id = await active(V1);
    install(id);
    await run(setMode("dual"), id);
    const up = seedJob(w, {
      kind: "upgrade",
      installId: id,
      args: { from: V1, to: V2 },
    });
    await runManage(w.ctx, event(up), stepRunner(w.clock).step);
    expect(w.job(up)?.status).toBe("done");
    expect(plain(id, "OAUTH_STORE")).toBe("dual");
    const back = seedJob(w, {
      kind: "rollback",
      installId: id,
      args: { from: V2, to: V1 },
    });
    await runManage(w.ctx, event(back), stepRunner(w.clock).step);
    expect(w.job(back)?.status).toBe("done");
    expect(plain(id, "OAUTH_STORE")).toBe("dual");
  });

  it("waits for the new version, then a mode that never shows is mode_not_live, with nothing recorded", async () => {
    const id = await active();
    let reads = 0;
    install(id, {
      mode: () => {
        reads++;
        return "kv";
      },
    });
    const r = await run(setMode("dual"), id);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "mode_not_live",
    });
    expect(reads).toBeGreaterThan(2);
    expect(
      auditOf(id).filter((a) => a.action === OAUTH_MODE_LIVE_ACTION),
    ).toEqual([]);
  });

  it("a mode that shows late passes", async () => {
    const id = await active();
    let reads = 0;
    install(id, { mode: () => (++reads > 3 ? "dual" : "kv") });
    const r = await run(setMode("dual"), id);
    expect(r.job.status).toBe("done");
  });

  it("a /healthz with no oauthStore (D1 unread) is not a pass", async () => {
    const id = await active();
    install(id);
    w.fake.health = (s) => ({
      ok: true,
      version: (s.metadata.tags as string[])
        .find((t: string) => /^v\d/.test(t))
        ?.slice(1),
      installId: id,
      oauthStore: null,
    });
    const r = await run(setMode("kv"), id);
    expect(r.job.status).toBe("failed");
    expect(plain(id, "OAUTH_STORE")).toBeUndefined();
  });

  const uploads = (id: string) => scriptOf(id).uploads;

  it("refuses d1 without a complete copy before any write", async () => {
    const id = await active();
    await dual(id);
    const before = uploads(id);
    const r = await run(setMode("d1"), id);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "copy_incomplete",
    });
    expect(uploads(id)).toBe(before);
    expect(plain(id, "OAUTH_STORE")).toBe("dual");
  });

  it("refuses kv to d1 even when /healthz says backfilled: d1 comes from dual", async () => {
    const id = await active();
    install(id, { backfilled: true });
    const before = uploads(id);
    const r = await run(setMode("d1"), id);
    expect(r.job.error_code).toBe("copy_incomplete");
    expect(uploads(id)).toBe(before);
  });

  it("takes d1 after a complete copy", async () => {
    const id = await active();
    await dual(id, { backfilled: true });
    const r = await run(setMode("d1"), id);
    expect(r.job.status).toBe("done");
    expect(plain(id, "OAUTH_STORE")).toBe("d1");
  });

  it("takes d1 with no OAUTH_KV binding: nothing to copy", async () => {
    const id = await active();
    install(id);
    w.fake.settingsEdit = (_s, b) => b.filter((x) => x.name !== "OAUTH_KV");
    const r = await run(setMode("d1"), id);
    expect(r.job.status).toBe("done");
    expect(plain(id, "OAUTH_STORE")).toBe("d1");
  });

  it.each([
    ["kv", "d1 on /healthz", { mode: () => "d1" }],
    ["dual", "d1 on /healthz", { mode: () => "d1" }],
    ["dual", "a kv-writes-off stamp", { off: 5 }],
  ])("refuses leaving d1 for %s, read from %s", async (to, _w, o) => {
    const id = await active();
    install(id, o);
    const before = uploads(id);
    const r = await run(setMode(to), id);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "leave_d1_refused",
    });
    expect(uploads(id)).toBe(before);
  });

  it("refuses leaving d1 when only the stored vars say d1", async () => {
    const id = await active();
    await dual(id, { backfilled: true });
    await run(setMode("d1"), id);
    install(id, { mode: () => "dual" });
    const r = await run(setMode("dual"), id);
    expect(r.job.error_code).toBe("leave_d1_refused");
    expect(plain(id, "OAUTH_STORE")).toBe("d1");
  });

  it("a rerun of d1 on a d1 install is fine", async () => {
    const id = await active();
    await dual(id, { backfilled: true });
    await run(setMode("d1"), id);
    const r = await run(setMode("d1"), id);
    expect(r.job.status).toBe("done");
  });

  it.each([
    ["an admin session", { actor: "admin", grant: null }],
    ["an oat_ token", { grant: "oat" }],
    ["a token with no token_id", { grant: null }],
    ["OIDC", { actor: "oidc", grant: null }],
    ["a user", { actor: "user", grant: null }],
    ["the system", { actor: "system", grant: null }],
  ] as const)("the recheck refuses a job by %s", async (_who, o) => {
    const id = await active();
    install(id);
    const r = await run(setMode("dual"), id, o);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(plain(id, "OAUTH_STORE")).toBeUndefined();
  });

  it("the recheck refuses a job whose grant row is gone", async () => {
    const id = await active();
    install(id);
    const job = seedJob(w, {
      kind: "update",
      installId: id,
      args: setMode("dual"),
      actor: "token",
    });
    w.db.prepare("UPDATE jobs SET token_id = 'gone' WHERE id = ?").run(job);
    await runManage(w.ctx, event(job), stepRunner(w.clock).step).catch(
      () => {},
    );
    expect(w.job(job)?.error_code).toBe("invalid_state");
  });

  it("the recheck refuses OIDC inside its own scope, with a grant row (the test admin's rows)", async () => {
    const s = seedCreate(w, { slug: "rl-a", testHooks: true });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
    expect(w.job(s.jobId)?.status).toBe("done");
    install(s.installId);
    const r = await run(setMode("dual"), s.installId, { actor: "oidc" });
    expect(r.job.token_id).not.toBeNull();
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(plain(s.installId, "OAUTH_STORE")).toBeUndefined();
  });

  it("a half oauthStore is not a pass", async () => {
    const id = await active();
    install(id);
    const ok = w.fake.health as NonNullable<typeof w.fake.health>;
    w.fake.health = (s) => ({
      ...(ok(s) as object),
      oauthStore: { mode: "dual" },
    });
    const r = await run(setMode("dual"), id);
    expect(r.job.status).toBe("failed");
    expect(
      auditOf(id).filter((a) => a.action === OAUTH_MODE_LIVE_ACTION),
    ).toEqual([]);
  });

  it.each([
    [{}],
    [{ vars: {} }],
    [{ vars: { OAUTH_STORE: "x" } }],
    [{ vars: { OAUTH_STORE: "dual", TIER: "team" } }],
    [{ vars: { OAUTH_STORE: "dual" }, oauthCopy: true }],
  ])("the recheck refuses args %j", async (args) => {
    const id = await active();
    install(id);
    const r = await run(args, id);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(plain(id, "OAUTH_STORE")).toBeUndefined();
  });

  it("refuses a suspended install in the recheck", async () => {
    const id = await active();
    install(id);
    w.db
      .prepare(
        "UPDATE install_lifecycle SET suspended_at = 1 WHERE install_id = ?",
      )
      .run(id);
    const r = await run(setMode("dual"), id);
    expect(r.job.error_code).toBe("invalid_state");
  });

  it("checks that fail after the upload are upgrade_incomplete: the vars are live", async () => {
    const id = await active();
    const f = install(id);
    expect(f).toBeDefined();
    const ok = w.fake.health as NonNullable<typeof w.fake.health>;
    w.fake.health = (s) => {
      const h = ok(s) as { oauthStore: { mode: string } };
      return plain(id, "OAUTH_STORE") === "dual" ? { ok: false } : h;
    };
    const r = await run(setMode("dual"), id);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "upgrade_incomplete",
    });
    expect(plain(id, "OAUTH_STORE")).toBe("dual");
    expect(w.install(id)?.state).toBe("active");
  });

  it("never swallows a lost lease: the step fails lease_held, the mode unverified", async () => {
    const id = await active();
    install(id);
    const ok = w.fake.health as NonNullable<typeof w.fake.health>;
    let stolen = false;
    w.fake.health = (s) => {
      if (plain(id, "OAUTH_STORE") === "dual" && !stolen) {
        stolen = true;
        w.db
          .prepare(
            "UPDATE installs SET lease = 'someone-else', lease_until = ? WHERE id = ?",
          )
          .run(w.clock.t + 3_600_000, id);
      }
      return ok(s);
    };
    const r = await run(setMode("dual"), id);
    expect(r.job.status).toBe("failed");
    // The attempt's own error is the lease; the rerun finds the row held.
    expect(r.log.find((l) => l.error)?.error?.message).toBe("lease_held");
    expect(r.log.some((l) => l.name === "mode_live")).toBe(false);
    expect(
      auditOf(id).filter((a) => a.action === OAUTH_MODE_LIVE_ACTION),
    ).toEqual([]);
    expect(auditOf(id).map((a) => a.action)).toContain("vars.lost_lease");
  });

  it("a lease this job left is released once it expires, as an upgrade's", async () => {
    const id = await active();
    install(id);
    let at: number | null = null;
    const r = await run(setMode("dual"), id, {
      onStep: (n) => {
        if (n !== "update_vars" || at !== null) return;
        at = w.clock.t;
        // A run that died under its claim: upgrading, under a lease it took.
        w.db
          .prepare(
            "UPDATE installs SET state = 'upgrading', lease = 'mine', lease_until = ? WHERE id = ?",
          )
          .run(w.clock.t + 30 * MIN, id);
      },
    });
    expect(r.job.status).toBe("failed");
    expect(r.log.map((l) => l.name)).toContain("fail_release");
    expect(w.install(id)?.lease ?? null).toBeNull();
    expect(w.install(id)?.state).toBe("active");
  });
});

describe("update: the KV to D1 copy (R30)", () => {
  async function copied(o: Parameters<typeof install>[1] = {}) {
    const id = await active();
    const f = await dual(id, o);
    const r = await run(COPY, id);
    return { id, f, r };
  }

  it("probes, walks the cursors, deletes the key, then reads backfilled", async () => {
    const { id, f, r } = await copied();
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "done", step: "done" });
    expect(keyBodies(f.calls)).toEqual([
      "[]",
      "{}",
      JSON.stringify({ cursor: CURSOR_A }),
      JSON.stringify({ cursor: CURSOR_B }),
    ]);
    expect(scriptOf(id).secrets.has(KEY)).toBe(false);
    const key = bearer(f.calls[0] as Call);
    expect(key.length).toBeGreaterThanOrEqual(43);
    expect(new Set(f.calls.map(bearer)).size).toBe(1);
  });

  it("deletes the key before it reads backfilled", async () => {
    const id = await active();
    const f = await dual(id);
    let keyAtVerify: boolean | null = null;
    await run(COPY, id, {
      onStep: (n) => {
        if (n === "verify") keyAtVerify = scriptOf(id).secrets.has(KEY);
      },
    });
    expect(f.calls.length).toBeGreaterThan(0);
    expect(keyAtVerify).toBe(false);
  });

  it("puts the counts on the job, summed per page", async () => {
    const { r } = await copied();
    expect(JSON.parse(r.job.args as string)).toEqual({
      oauthCopy: true,
      counts: {
        kvKeys: 1605,
        copied: 1404,
        skippedExpiring: 201,
        d1Rows: 1604,
      },
    });
  });

  it("restarted: true drops the sums and the loop goes on", async () => {
    const { r, f } = await copied({
      pages: [
        page({ nextCursor: CURSOR_A }),
        page({
          kvKeys: 10,
          copied: 9,
          skippedExpiring: 1,
          nextCursor: CURSOR_B,
          restarted: true,
        }),
        page({ kvKeys: 2, copied: 2, skippedExpiring: 0, d1Rows: 11 }),
      ],
    });
    expect(r.job.status).toBe("done");
    expect(JSON.parse(r.job.args as string).counts).toEqual({
      kvKeys: 12,
      copied: 11,
      skippedExpiring: 1,
      d1Rows: 11,
    });
    expect(keyBodies(f.calls).filter((b) => b === "{}")).toHaveLength(1);
  });

  it("counts a cursor answered twice once, last write wins", async () => {
    const { r } = await copied({
      pages: [
        page({ nextCursor: CURSOR_A }),
        page({
          kvKeys: 1,
          copied: 1,
          skippedExpiring: 0,
          nextCursor: CURSOR_A,
        }),
        page({ kvKeys: 7, copied: 7, skippedExpiring: 0, d1Rows: 8 }),
      ],
    });
    expect(JSON.parse(r.job.args as string).counts).toEqual({
      kvKeys: 807,
      copied: 707,
      skippedExpiring: 100,
      d1Rows: 8,
    });
  });

  it("a pass that never ends fails at the page cap, and the key goes", async () => {
    const pages = Array.from({ length: COPY_MAX_PAGES + 5 }, (_, i) =>
      page({ nextCursor: `gen.c${i}` }),
    );
    const { id, r, f } = await copied({ pages });
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "copy_incomplete",
    });
    expect(f.pages.length).toBe(5);
    expect(scriptOf(id).secrets.has(KEY)).toBe(false);
  });

  it("a page retried after a 500 resends its cursor, never {}, and counts once", async () => {
    let failed = false;
    const { r, f } = await copied({
      respond: (c) => {
        if (c.body.includes(CURSOR_B) && !failed) {
          failed = true;
          return new Response("boom", { status: 500 });
        }
        return undefined;
      },
    });
    expect(r.job.status).toBe("done");
    expect(keyBodies(f.calls).filter((b) => b === "{}")).toHaveLength(1);
    expect(keyBodies(f.calls).filter((b) => b.includes(CURSOR_B))).toHaveLength(
      2,
    );
    expect(JSON.parse(r.job.args as string).counts.kvKeys).toBe(1605);
  });

  it("a step run twice (a replay) doesn't double the counts", async () => {
    const id = await active();
    const pages = THREE_PAGES.flatMap((p) => [p, p]);
    await dual(id, { pages });
    const r = await run(COPY, id, { twice: true });
    expect(r.job.status).toBe("done");
    expect(JSON.parse(r.job.args as string).counts.kvKeys).toBe(1605);
  });

  it("a reasonless 404 mid-loop is the rate limit: it backs off and resends the cursor", async () => {
    let limited = 0;
    const { r, f } = await copied({
      respond: (c) => {
        if (c.body.includes(CURSOR_A) && limited++ < 2)
          return new Response(null, { status: 404 });
        return undefined;
      },
    });
    expect(r.job.status).toBe("done");
    const a = f.calls.filter((c) => c.body.includes(CURSOR_A));
    expect(a).toHaveLength(3);
    expect((a[1] as Call).at - (a[0] as Call).at).toBeGreaterThanOrEqual(5_000);
    expect(r.log.some((l) => l.error)).toBe(false);
  });

  it("a rate limit that never lifts fails, and the key still goes", async () => {
    const { id, r } = await copied({
      respond: (c) =>
        c.body.includes(CURSOR_A)
          ? new Response(null, { status: 404 })
          : undefined,
    });
    expect(r.job.status).toBe("failed");
    expect(scriptOf(id).secrets.has(KEY)).toBe(false);
  });

  it("stays under 30 calls a minute", async () => {
    const pages = Array.from({ length: 60 }, (_, i) =>
      page(i === 59 ? { d1Rows: 1 } : { nextCursor: `gen.c${i}` }),
    );
    const { r, f } = await copied({ pages });
    expect(r.job.status).toBe("done");
    for (const c of f.calls) {
      const within = f.calls.filter(
        (x) => x.at >= c.at && x.at < c.at + 60_000,
      );
      expect(within.length).toBeLessThan(30);
    }
  });

  it.each([
    ["not_dual", "copy_not_dual"],
    ["markers", "copy_markers"],
  ])(
    "%s mid-loop is terminal, %s, and the key is deleted",
    async (reason, code) => {
      const { id, r, f } = await copied({
        respond: (c) =>
          c.body.includes(CURSOR_A) ? refusal(reason) : undefined,
      });
      expect(r.job).toMatchObject({ status: "failed", error_code: code });
      expect(f.calls.filter((c) => c.body.includes(CURSOR_A))).toHaveLength(1);
      expect(scriptOf(id).secrets.has(KEY)).toBe(false);
    },
  );

  it("polls the probe until bad_input", async () => {
    const { r, f } = await copied({ staleProbes: 3 });
    expect(r.job.status).toBe("done");
    expect(keyBodies(f.calls).filter((b) => b === "[]")).toHaveLength(4);
  });

  it("a key that never goes live fails copy_key_not_live at the deadline, and is deleted", async () => {
    const { id, r, f } = await copied({ staleProbes: 1000 });
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "copy_key_not_live",
    });
    expect(keyBodies(f.calls)).not.toContain("{}");
    expect(scriptOf(id).secrets.has(KEY)).toBe(false);
  });

  it("a probe 503 is terminal (markers), and the key is deleted", async () => {
    const { id, r, f } = await copied({
      respond: (c) =>
        c.body === "[]" ? new Response(null, { status: 503 }) : undefined,
    });
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "copy_markers",
    });
    expect(f.calls).toHaveLength(1);
    expect(scriptOf(id).secrets.has(KEY)).toBe(false);
  });

  it("nextCursor null with d1Rows null isn't done", async () => {
    const { id, r } = await copied({ pages: [page({ d1Rows: null })] });
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "copy_incomplete",
    });
    expect(scriptOf(id).secrets.has(KEY)).toBe(false);
  });

  it("/healthz not backfilled after the last page fails, the key gone", async () => {
    const { id, r } = await copied({
      afterLast: (s) => {
        s.backfilled = false;
      },
    });
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "copy_incomplete",
    });
    expect(scriptOf(id).secrets.has(KEY)).toBe(false);
  });

  it("a failed delete rotates to a key nobody holds and fails copy_key_left", async () => {
    const id = await active();
    const f = await dual(id);
    w.fake.inject((m, p) => m === "DELETE" && p.includes("/secrets/"), {
      status: 500,
      times: 100,
    });
    const r = await run(COPY, id);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "copy_key_left",
    });
    const left = scriptOf(id).secrets.get(KEY) as string;
    expect(left.length).toBeGreaterThanOrEqual(43);
    expect(left).not.toBe(bearer(f.calls[0] as Call));
    expect(JSON.stringify(r.log)).not.toContain(left);
  });

  it("a failed delete and a failed rotate still fail copy_key_left", async () => {
    const id = await active();
    await dual(id);
    let at: "put" | "drop" = "put";
    const r = await run(COPY, id, {
      onStep: (n) => {
        if (n === "drop_copy_key" && at === "put") {
          at = "drop";
          w.fake.inject((m, p) => p.includes("/secrets"), {
            status: 500,
            times: 1000,
          });
        }
      },
    });
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "copy_key_left",
    });
  });

  it("a key left by a job doesn't fail the next upgrade's verify_clean", async () => {
    const id = await active(V1);
    await dual(id);
    w.fake.inject((m, p) => m === "DELETE" && p.includes("/secrets/"), {
      status: 500,
      times: 100,
    });
    await run(COPY, id);
    const up = seedJob(w, {
      kind: "upgrade",
      installId: id,
      args: { from: V1, to: V2 },
    });
    await runManage(w.ctx, event(up), stepRunner(w.clock).step);
    expect(w.job(up)?.status).toBe("done");
  });

  it("the key and cursors never reach jobs, the audit or a log, on success or failure", async () => {
    const ok = await copied();
    secrecy([bearer(ok.f.calls[0] as Call), CURSOR_A, CURSOR_B]);
    w = await world();
    const bad = await copied({
      respond: (c) =>
        c.body.includes(CURSOR_B)
          ? new Response(`${c.auth} ${c.body}`, { status: 500 })
          : undefined,
    });
    expect(bad.r.job.status).toBe("failed");
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain("job_step_failed");
    secrecy([bearer(bad.f.calls[0] as Call), CURSOR_A, CURSOR_B]);
  });

  describe("preconditions, all before any key", () => {
    const noKey = (id: string, calls: Call[]) => {
      expect(scriptOf(id).secrets.has(KEY)).toBe(false);
      expect(calls).toEqual([]);
    };

    it("needs /healthz to show dual", async () => {
      const id = await active();
      const f = await dual(id);
      install(id, { mode: () => "kv" });
      const r = await run(COPY, id);
      expect(r.job).toMatchObject({
        status: "failed",
        error_code: "copy_not_dual",
      });
      noKey(id, f.calls);
    });

    it("needs the stored mode dual", async () => {
      const id = await active();
      const f = install(id, { mode: () => "dual" });
      const r = await run(COPY, id);
      expect(r.job.error_code).toBe("copy_not_dual");
      noKey(id, f.calls);
    });

    it("needs R29's record: dual verified, not just set", async () => {
      const id = await active();
      const f = await dual(id);
      w.db.exec("DROP TRIGGER IF EXISTS hosted_audit_no_delete");
      w.db
        .prepare("DELETE FROM hosted_audit WHERE action = ?")
        .run(OAUTH_MODE_LIVE_ACTION);
      const r = await run(COPY, id);
      expect(r.job.error_code).toBe("invalid_state");
      noKey(id, f.calls);
    });

    it("needs dual live for at least 60 s", async () => {
      const id = await active();
      const f = install(id);
      await run(setMode("dual"), id);
      w.clock.t += 59_000;
      // The recheck and precheck run at the same pinned time here.
      const r = await run(COPY, id);
      expect(r.job.error_code).toBe("invalid_state");
      noKey(id, f.calls);
    });

    it("refuses a row left upgrading", async () => {
      const id = await active();
      const f = await dual(id);
      w.db
        .prepare("UPDATE installs SET state = 'upgrading' WHERE id = ?")
        .run(id);
      const r = await run(COPY, id);
      expect(r.job.error_code).toBe("invalid_state");
      noKey(id, f.calls);
    });

    it("refuses a job with no OAuth grant", async () => {
      const id = await active();
      const f = await dual(id);
      const r = await run(COPY, id, { grant: "oat" });
      expect(r.job.error_code).toBe("invalid_state");
      noKey(id, f.calls);
    });

    it("a token that's near its end refuses before any key", async () => {
      const id = await active();
      const f = await dual(id);
      w.fake.tokenInfo.expires_on = new Date(
        w.clock.t + 86_400_000,
      ).toISOString();
      const r = await run(COPY, id);
      expect(r.job.status).toBe("failed");
      noKey(id, f.calls);
    });
  });
});

describe("cleanup of a canceled or dead copy", () => {
  const cleanup = async (parent: string, installId: string) => {
    const id = seedJob(w, {
      kind: "cleanup",
      installId,
      parentJobId: parent,
      actor: "system",
      // As the scheduler's sweep and R25 write it: the parent's kind and args
      // aren't in here, so a cleanup reads the parent row.
      args: { parentJobId: parent },
    });
    const r = stepRunner(w.clock);
    const error = await runManage(w.ctx, event(id), r.step).then(
      () => null,
      (x: unknown) => x as Error,
    );
    return { id, error, log: r.log };
  };
  /** A copy that stopped with the key up: terminated, or a dead run. */
  const dead = (installId: string, args: Record<string, unknown> = COPY) => {
    scriptOf(installId).secrets.set(KEY, "k".repeat(64));
    return seedJob(w, {
      kind: "update",
      installId,
      args,
      status: "failed",
    });
  };

  it("deletes the key and settles the parent", async () => {
    const id = await active();
    const parent = dead(id);
    const c = await cleanup(parent, id);
    expect(c.error).toBeNull();
    expect(scriptOf(id).secrets.has(KEY)).toBe(false);
    expect(w.job(c.id)?.status).toBe("done");
  });

  it("is a no-op when the key is already gone", async () => {
    const id = await active();
    const parent = dead(id);
    scriptOf(id).secrets.delete(KEY);
    const c = await cleanup(parent, id);
    expect(c.error).toBeNull();
    expect(w.job(c.id)?.status).toBe("done");
  });

  it("rotates when the delete fails, settles anyway, and fails copy_key_left", async () => {
    const id = await active();
    const parent = dead(id);
    w.fake.inject((m, p) => m === "DELETE" && p.includes("/secrets/"), {
      status: 500,
      times: 100,
    });
    const c = await cleanup(parent, id);
    expect(c.error).not.toBeNull();
    expect(scriptOf(id).secrets.get(KEY)).not.toBe("k".repeat(64));
    expect(w.job(c.id)).toMatchObject({
      status: "failed",
      error_code: "copy_key_left",
    });
    expect(c.log.map((l) => l.name)).toContain("settle");
  });

  it("leaves the secrets of any other parent alone", async () => {
    const id = await active();
    const parent = dead(id, setMode("dual"));
    const c = await cleanup(parent, id);
    expect(c.error).toBeNull();
    expect(scriptOf(id).secrets.has(KEY)).toBe(true);
  });
});
