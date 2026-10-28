import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { accessLevel, callerOf, capOfCaller } from "../src/auth/authz.js";
import { createPat } from "../src/auth/pat.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { direct, uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";
import { callWorker, MCP_URL } from "./mcp-helpers.js";

// P2 Task 9: guests are read-only under direct sign-in (and every code
// session outside the verified domains, whatever the env says).
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const SESSION = sessionCookieName(env);

const call = (
  e: Env,
  path: string,
  cookie: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) =>
  app.fetch(
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        cookie,
        "x-oa-request": "1",
        ...init.headers,
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    e,
    ctx,
  );

/** An artifact with the db + storage capabilities, shared with `email` as editor. */
async function sharedArtifact(email: string): Promise<string> {
  const o = await login(uniq("own"));
  const owner = await getUser(env, o.userId);
  const { id } = await publish(
    env,
    owner as never,
    {
      title: "t",
      format: "html",
      content: "<p>x</p>",
      capabilities: { db: true, storage: true, viewer: false },
    } as never,
    null,
    undefined,
    "create",
  );
  await env.DB.prepare(
    "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'editor', ?, ?)",
  )
    .bind(id, email, o.userId, Date.now())
    .run();
  return id;
}

/** A session cookie for `email` as `role`, signed the way `provider` would. */
async function sessionFor(
  email: string,
  role: "guest" | "member",
  provider: "access" | "code" = "access",
  tenant?: string,
) {
  const { userId } = await login(email, role);
  return `${SESSION}=${await signSession(env, userId, Date.now(), { provider, tenant, epoch: 0 })}`;
}

/** An Access-only install (no google, no email). */
const ACCESS_ONLY = { ...env, AUTH_PROVIDERS: "access" } as Env;

const WRITES = (id: string) =>
  [
    ["PATCH", R.artifact(id), { title: "x" }],
    ["DELETE", R.artifact(id), undefined],
    ["POST", R.versions(id), { format: "html", content: "<p>y</p>" }],
    ["PUT", R.shares(id), { email: "z@x.com", role: "viewer" }],
    ["PUT", R.dataDoc(id, "c", "d"), { v: 1 }],
    ["DELETE", R.dataDoc(id, "c", "d"), undefined],
    ["PUT", R.storageKey(id, "k"), { v: 1 }],
    ["POST", R.uploads, { path: "a.txt", size: 1, contentType: "text/plain" }],
  ] as const;

describe("guest read cap (direct sign-in)", () => {
  it("a guest with an editor share can read, but every write is refused", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    const e = direct();
    expect((await call(e, R.artifact(id), g)).status).toBe(200);
    for (const [method, path, body] of WRITES(id)) {
      const r = await call(e, path, g, { method, body });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    const create = await call(e, R.artifacts, g, {
      method: "POST",
      body: { title: "n", format: "markdown", content: "x" },
    });
    expect(create.status).toBe(403);
    expect(
      ((await create.json()) as { error: { code: string } }).error.code,
    ).toBe("space_forbidden");
  });

  it("the artifact reads back as viewer for a capped guest", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const { userId } = await login(uniq("g2", "x.com"), "guest");
    await env.DB.prepare(
      "update shares set email = (select email from users where id = ?) where artifact_id = ?",
    )
      .bind(userId, id)
      .run();
    const user = await getUser(env, userId);
    const level = await accessLevel(
      env,
      { kind: "user", user: user as never, cap: "guest" },
      id,
    );
    expect(level?.level).toBe("viewer");
    const uncapped = await accessLevel(
      env,
      { kind: "user", user: user as never },
      id,
    );
    expect(uncapped?.level).toBe("editor");
  });

  it("the guest can still set their own display name", async () => {
    const g = await sessionFor(uniq("g", "x.com"), "guest");
    expect(
      (
        await call(direct(), R.me, g, {
          method: "PATCH",
          body: { displayName: "Gee" },
        })
      ).status,
    ).toBe(200);
  });

  it("H3: with AUTH_PROVIDERS=access,email a guest is capped", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    const e = { ...env, AUTH_PROVIDERS: "access,email" } as Env;
    expect(
      (
        await call(e, R.artifact(id), g, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(404);
  });

  it("H3: a code session outside the domains is capped even on an Access-only install", async () => {
    const email = uniq("m", "x.com");
    const id = await sharedArtifact(email);
    const c = await sessionFor(email, "member", "code");
    expect(
      (
        await call(env, R.artifact(id), c, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(404);
  });

  it("parity 2: Access-only installs cap guests too; the share row keeps editor", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    expect(
      (
        await call(ACCESS_ONLY, R.artifact(id), g, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(404);
    const row = await env.DB.prepare(
      "select role from shares where artifact_id = ? and email = ?",
    )
      .bind(id, email)
      .first<{ role: string }>();
    expect(row?.role).toBe("editor");
  });

  it("a capped guest can open the live socket, and writes stay refused", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    const e = direct();
    const r = await call(e, R.dataSubscribe(id, "c"), g, {
      headers: { upgrade: "websocket" },
    });
    expect(r.status).toBe(101);
    r.webSocket?.accept();
    r.webSocket?.close();
    expect(
      (
        await call(e, R.dataDoc(id, "c", "d"), g, {
          method: "PUT",
          body: { v: 1 },
        })
      ).status,
    ).toBe(404);
  });

  it("a capped guest can query data (a read); a data write stays refused", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    const e = direct();
    const q = await call(e, R.dataQuery(id, "c"), g, {
      method: "POST",
      body: {},
    });
    expect(q.status).toBe(200);
    const w = await call(e, R.dataDoc(id, "c", "query"), g, {
      method: "PUT",
      body: { v: 1 },
    });
    expect(w.status).toBe(404);
    // Only the exact route: a POST elsewhere under the collection is refused.
    expect(
      (
        await call(e, `${R.dataQuery(id, "c")}/x`, g, {
          method: "POST",
          body: {},
        })
      ).status,
    ).toBe(404);
  });

  it("an Access-only guest is capped on an Access and a code session alike", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const { userId } = await login(email, "guest");
    const cookie = async (provider: "access" | "code") =>
      `${SESSION}=${await signSession(env, userId, Date.now(), { provider, epoch: 0 })}`;
    for (const p of ["access", "code"] as const)
      expect(
        (
          await call(ACCESS_ONLY, R.artifact(id), await cookie(p), {
            method: "PATCH",
            body: { title: "x" },
          })
        ).status,
        p,
      ).toBe(404);
  });

  it("a capped guest can revoke their own token, not someone else's", async () => {
    const email = uniq("g", "x.com");
    const { userId } = await login(email, "guest");
    const g = `${SESSION}=${await signSession(env, userId, Date.now(), { provider: "access", epoch: 0 })}`;
    const own = await createPat(env, userId, "mine");
    const other = await login(uniq("o"));
    const theirs = await createPat(env, other.userId, "theirs");
    const e = direct();
    expect(
      (await call(e, R.token(theirs.id), g, { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (await call(e, R.token(own.id), g, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await call(e, R.tokens, g, { method: "POST", body: { label: "n" } }))
        .status,
    ).toBe(404);
  });

  it("members are untouched under direct sign-in", async () => {
    const email = uniq("m");
    const id = await sharedArtifact(email);
    const m = await sessionFor(email, "member", "access");
    expect(
      (
        await call(direct(), R.artifact(id), m, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(200);
  });
});

// Parity 2: guests are view-only on every install. Each guest write path an
// Access guest holding an editor share could reach, on an Access-only install.
describe("guest read cap (Access-only install, parity 2)", () => {
  /** Every artifact write a share could grant, plus the uncapped control. */
  const ALL_WRITES = (id: string) =>
    [
      ...WRITES(id),
      ["PATCH", R.dataDoc(id, "c", "d"), { v: 2 }],
      ["PUT", R.dataReset(id), { c: { d: { v: 1 } } }],
      ["DELETE", R.storageKey(id, "k"), undefined],
      ["POST", R.restoreVersion(id, 1), undefined],
      ["PUT", R.thumbnail(id), undefined],
      ["DELETE", R.share(id, "z@x.com"), undefined],
      ["POST", R.restoreDeleted(id), undefined],
    ] as const;

  it("an Access guest with an editor share reads, and every write path is refused", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const g = await sessionFor(email, "guest");
    expect((await call(ACCESS_ONLY, R.artifact(id), g)).status).toBe(200);
    for (const [method, path, body] of ALL_WRITES(id)) {
      const r = await call(ACCESS_ONLY, path, g, { method, body });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // Publishing a new artifact: the contract's 403, never a create.
    const create = await call(ACCESS_ONLY, R.artifacts, g, {
      method: "POST",
      body: { title: "n", format: "markdown", content: "x" },
    });
    expect(create.status).toBe(403);
    expect(
      ((await create.json()) as { error: { code: string } }).error.code,
    ).toBe("space_forbidden");
    // Nothing was written: no new version, no title change, no data.
    const a = await env.DB.prepare(
      "select title, current_version v from artifacts where id = ?",
    )
      .bind(id)
      .first<{ title: string; v: number }>();
    expect(a).toEqual({ title: "t", v: 1 });
    expect((await call(ACCESS_ONLY, R.dataDoc(id, "c", "d"), g)).status).toBe(
      404,
    );
  });

  it("the same guest's PAT is refused on REST writes and at /mcp", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const { userId } = await login(email, "guest");
    const { token } = await createPat(env, userId, "g");
    const bearer = (method: string, path: string, body?: unknown) =>
      app.fetch(
        new Request(`http://app.localhost${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        ACCESS_ONLY,
        ctx,
      );
    expect((await bearer("GET", R.artifact(id))).status).toBe(200);
    for (const [method, path, body] of ALL_WRITES(id))
      expect(
        (await bearer(method, path, body)).status,
        `${method} ${path}`,
      ).toBe(404);
    expect(
      (
        await bearer("POST", R.artifacts, {
          title: "n",
          format: "markdown",
          content: "x",
        })
      ).status,
    ).toBe(403);
    // MCP (every tool, publish and data writes included): members only.
    const mcp = await callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      ACCESS_ONLY,
    );
    expect(mcp.status).toBe(401);
    expect(
      ((await mcp.json()) as { error: { message: string } }).error.message,
    ).toBe("Only members can connect agents");
  });

  it("the guest's caller carries the cap and reads the editor share as viewer", async () => {
    const email = uniq("g", "x.com");
    const id = await sharedArtifact(email);
    const { userId } = await login(email, "guest");
    const user = await getUser(ACCESS_ONLY, userId);
    const who = callerOf(user as NonNullable<typeof user>);
    expect(capOfCaller(who)).toBe("guest");
    expect((await accessLevel(ACCESS_ONLY, who, id))?.level).toBe("viewer");
  });

  it("a member holding the same editor share still writes (control)", async () => {
    const email = uniq("m");
    const id = await sharedArtifact(email);
    const m = await sessionFor(email, "member");
    expect(
      (
        await call(ACCESS_ONLY, R.artifact(id), m, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(ACCESS_ONLY, R.dataDoc(id, "c", "d"), m, {
          method: "PUT",
          body: { v: 1 },
        })
      ).status,
    ).toBe(200);
  });
});
