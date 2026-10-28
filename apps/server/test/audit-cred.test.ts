import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import type { MiddlewareHandler } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { currentCred, withCred } from "../src/auth/cred.js";
import { createPat } from "../src/auth/pat.js";
import { mw } from "../src/auth/route-policy.js";
import { readSession } from "../src/auth/session.js";
import type { DirectorySync } from "../src/directory/sync-do.js";
import { type AppEnv, resolveSession } from "../src/http/middleware.js";
import { type AppType, mountRoutes } from "../src/routes/index.js";
import {
  audit,
  listAudit,
  signInAudit,
  signInAuditByEmail,
  userActor,
  withRequestCred,
} from "../src/services/audit.js";
import { uniq } from "./auth-helpers.js";
import { api, login } from "./helpers.js";
import { connect, oauthToken, tool } from "./mcp-helpers.js";

// #803: every audit row for a user's action names the credential behind it
// (session, PAT, OAuth grant), by id, never the token.

const app = createApp();

type CredRow = { kind: string | null; id: string | null };
const credOfRows = async (target: string, extra = "1") =>
  (
    await env.DB.prepare(
      `select actor_cred_kind kind, actor_cred_id id from audit_events
        where target_id = ? and ${extra} order by at, id`,
    )
      .bind(target)
      .all<CredRow>()
  ).results;

/** The session cookie's credential id, as the middleware derives it. */
async function sessionId(cookie: string): Promise<string> {
  const value = cookie.slice(cookie.indexOf("=") + 1);
  const s = await readSession(env, value);
  if (!s) throw new Error("bad test cookie");
  return `${s.p}:${s.iat}`;
}

async function publish(auth: string): Promise<string> {
  const r = await api(app, R.artifacts, auth, {
    method: "POST",
    body: { title: "Cred", format: "markdown", content: "# hi" },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
const toTeam = (a: AppType, auth: string, id: string) =>
  api(a, R.artifact(id), auth, {
    method: "PATCH",
    body: { visibility: "team" },
  });

/** Every token, cookie and secret the tests minted: none may reach a row. */
const secrets: string[] = [];

let alice: { cookie: string; userId: string };
let bob: { cookie: string; userId: string };
let bobPat: { id: string; token: string };

beforeAll(async () => {
  alice = await login(uniq("alice"));
  bob = await login(uniq("bob"));
  bobPat = await createPat(env, bob.userId, "ci");
  secrets.push(alice.cookie, bob.cookie, bobPat.token);
});

describe("one row per credential kind", () => {
  it("REST with a session cookie records the session", async () => {
    const id = await publish(alice.cookie);
    expect((await toTeam(app, alice.cookie, id)).status).toBe(200);
    expect(await credOfRows(id, "action = 'artifact.visibility'")).toEqual([
      { kind: "session", id: await sessionId(alice.cookie) },
    ]);
  });

  it("REST with a PAT records the token id", async () => {
    const id = await publish(bobPat.token);
    expect((await toTeam(app, bobPat.token, id)).status).toBe(200);
    expect(await credOfRows(id, "action = 'artifact.visibility'")).toEqual([
      { kind: "pat", id: bobPat.id },
    ]);
  });

  it("MCP with an OAuth grant records the grant id", async () => {
    const t = await oauthToken(uniq("carol"));
    secrets.push(t.accessToken, t.refreshToken, t.member.cookie);
    const grantId = t.accessToken.split(":")[1];
    expect(grantId).toBeTruthy();
    const id = await publish(t.member.cookie);
    const client = await connect(t.accessToken);
    const r = await tool(client, "set_visibility", { id, visibility: "team" });
    expect(r.isError).toBeFalsy();
    await client.close();
    expect(await credOfRows(id, "action = 'artifact.visibility'")).toEqual([
      { kind: "oauth_grant", id: grantId },
    ]);
  });

  it("MCP with a PAT records the token id", async () => {
    const id = await publish(bobPat.token);
    const client = await connect(bobPat.token);
    const r = await tool(client, "set_visibility", { id, visibility: "team" });
    expect(r.isError).toBeFalsy();
    await client.close();
    expect(await credOfRows(id, "action = 'artifact.visibility'")).toEqual([
      { kind: "pat", id: bobPat.id },
    ]);
  });

  it("the audit API returns actor.cred", async () => {
    const owner = await login(uniq("owner"), "owner");
    secrets.push(owner.cookie);
    const id = await publish(bobPat.token);
    expect((await toTeam(app, bobPat.token, id)).status).toBe(200);
    const page = await listAudit(env, undefined, 100);
    const e = page.items.find(
      (x) => x.target.id === id && x.action === "artifact.visibility",
    );
    expect(e?.actor).toMatchObject({
      kind: "user",
      id: bob.userId,
      cred: { kind: "pat", id: bobPat.id },
    });
    const r = await api(app, `${R.audit}?limit=100`, owner.cookie);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: { target: { id: string }; actor: { cred?: unknown } }[];
    };
    expect(body.items.find((x) => x.target.id === id)?.actor.cred).toEqual({
      kind: "pat",
      id: bobPat.id,
    });
  });
});

/** A promise and its resolver. */
const latch = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
};

describe("the store never bleeds between requests", () => {
  it("two concurrent requests with different credentials each audit their own", async () => {
    // Both requests resolve their credential, then wait for each other
    // before the handler writes, so their audit writes interleave.
    const arrived: (() => void)[] = [];
    const both = latch();
    const rendezvous: MiddlewareHandler<AppEnv> = async (_c, next) => {
      arrived.push(() => undefined);
      if (arrived.length === 2) both.open();
      await both.p;
      await next();
    };
    const racing = createApp((a: AppType) => {
      a.use("/api/v1/artifacts/:id", mw(rendezvous));
      mountRoutes(a);
    });
    const ida = await publish(alice.cookie);
    const idb = await publish(bobPat.token);
    const [ra, rb] = await Promise.all([
      toTeam(racing, alice.cookie, ida),
      toTeam(racing, bobPat.token, idb),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await credOfRows(ida, "action = 'artifact.visibility'")).toEqual([
      { kind: "session", id: await sessionId(alice.cookie) },
    ]);
    expect(await credOfRows(idb, "action = 'artifact.visibility'")).toEqual([
      { kind: "pat", id: bobPat.id },
    ]);
  });

  it("waitUntil work from A that finishes after B began records A's credential", async () => {
    const ida = await publish(alice.cookie);
    const bStarted = latch();
    const aQueued = latch();
    const probe = (c: Parameters<MiddlewareHandler<AppEnv>>[0]) =>
      c.req.header("x-probe");
    const hook: MiddlewareHandler<AppEnv> = async (c, next) => {
      await resolveSession(c);
      if (probe(c) === "a") {
        // A's background write waits until B is mid-request.
        c.executionCtx.waitUntil(
          (async () => {
            await bStarted.p;
            await audit(
              c.env,
              "artifact.visibility",
              { type: "artifact", id: ida },
              userActor(alice.userId),
              { detail: { probe: "late" } },
            ).run();
          })(),
        );
        aQueued.open();
      }
      if (probe(c) === "b") bStarted.open();
      await next();
    };
    const racing = createApp((a: AppType) => {
      a.use("/api/v1/artifacts/:id", mw(hook));
      mountRoutes(a);
    });
    const ctxA = createExecutionContext();
    const reqA = new Request(`http://app.localhost${R.artifact(ida)}`, {
      headers: { cookie: alice.cookie, "x-probe": "a" },
    });
    const ra = await racing.fetch(reqA, env, ctxA);
    expect(ra.status).toBe(200);
    await aQueued.p;
    // Request A has returned; its waitUntil is still pending. B now runs
    // with a PAT, and its arrival releases A's background write.
    const idb = await publish(bobPat.token);
    const rb = await api(racing, R.artifact(idb), bobPat.token, {
      method: "PATCH",
      body: { visibility: "team" },
      headers: { "x-probe": "b" },
    });
    expect(rb.status).toBe(200);
    await waitOnExecutionContext(ctxA);
    expect(
      await credOfRows(ida, "json_extract(detail, '$.probe') = 'late'"),
    ).toEqual([{ kind: "session", id: await sessionId(alice.cookie) }]);
    expect(await credOfRows(idb, "action = 'artifact.visibility'")).toEqual([
      { kind: "pat", id: bobPat.id },
    ]);
  });

  it("a Durable Object never inherits the caller's credential; it records what it is passed", async () => {
    const ns = env.DIRECTORY_SYNC;
    if (!ns) throw new Error("DIRECTORY_SYNC unbound");
    const stub = ns.get(
      ns.idFromName(`cred-${crypto.randomUUID()}`),
    ) as unknown as DurableObjectStub<DirectorySync>;
    // Creates the DO's tables, then holds two sweeps to confirm.
    await stub.status();
    const [g1, g2] = [
      `grp-${crypto.randomUUID()}`,
      `grp-${crypto.randomUUID()}`,
    ];
    await runInDurableObject(stub, (_i, s) => {
      for (const g of [g1, g2])
        s.storage.sql.exec(
          "insert into held (group_id, since, kind, would) values (?, ?, 'sweep', 1)",
          g,
          Date.now(),
        );
    });
    const pat = { kind: "pat" as const, id: bobPat.id };
    // A bare user actor, called from inside a request holding a PAT: the DO
    // sees no credential and records none. The RPC boundary already drops
    // the caller's store (this passes without withoutCred too); DirectorySync's
    // withoutCred is defence in depth.
    await withCred(pat, () =>
      stub.confirmHeld(g1, userActor(bob.userId)),
    ).catch(() => undefined);
    // withRequestCred fixes the request's credential on the actor: recorded.
    await withCred(pat, () =>
      stub.confirmHeld(g2, withRequestCred(userActor(bob.userId))),
    ).catch(() => undefined);
    expect(
      await credOfRows(g1, "action = 'directory.sweep.confirmed'"),
    ).toEqual([{ kind: null, id: null }]);
    expect(
      await credOfRows(g2, "action = 'directory.sweep.confirmed'"),
    ).toEqual([pat]);
  });

  it("sign-in rows record no credential, even inside a request holding one", async () => {
    const email = uniq("signin");
    const u = await login(email);
    await withCred({ kind: "session", id: "access:1" }, async () => {
      await signInAudit(env, u.userId, "code").run();
      await signInAuditByEmail(env, email, "access");
    });
    expect(await credOfRows(u.userId, "action = 'auth.signin'")).toEqual([
      { kind: null, id: null },
      { kind: null, id: null },
    ]);
  });

  it("cron, sync and alarm writes have no request credential", async () => {
    const t = `tgt-${crypto.randomUUID()}`;
    // Outside any request: no slot at all.
    expect(currentCred()).toBeNull();
    await env.DB.batch([
      audit(env, "space.delete", { type: "space", id: t }, userActor("u")),
      audit(
        env,
        "directory.sync",
        { type: "directory", id: t },
        {
          kind: "sync",
          id: null,
        },
      ),
      audit(
        env,
        "user.status",
        { type: "user", id: t },
        {
          kind: "system",
          id: null,
        },
      ),
    ]);
    const byAction = async (a: string) => credOfRows(t, `action = '${a}'`);
    expect(await byAction("space.delete")).toEqual([{ kind: null, id: null }]);
    expect(await byAction("directory.sync")).toEqual([
      { kind: "system", id: null },
    ]);
    expect(await byAction("user.status")).toEqual([
      { kind: "system", id: null },
    ]);
  });
});

describe("no token text in any row", () => {
  it("no audit row holds a token, cookie or secret", async () => {
    const { results } = await env.DB.prepare("select * from audit_events").all<
      Record<string, unknown>
    >();
    expect(results.length).toBeGreaterThan(0);
    const dump = JSON.stringify(results);
    // The whole value, and its secret part: an OAuth token's last segment
    // (`user:grant:secret`), a cookie's payload and MAC (`name=payload.mac`).
    // Its user and grant ids are not secret and do appear.
    const parts = secrets.flatMap((s) => {
      const v = s.includes("=") ? s.slice(s.indexOf("=") + 1) : s;
      return [s, v, v.split(":").at(-1) ?? s, ...v.split(".")];
    });
    for (const p of parts) {
      expect(p.length).toBeGreaterThanOrEqual(16);
      expect(dump).not.toContain(p);
    }
  });
});
