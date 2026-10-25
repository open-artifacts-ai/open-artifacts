import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  R,
  SpaceSchema,
  TEST_HOOKS,
  TestSessionResultSchema,
} from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import realWorker from "../src/index.js";
import type { UserPresence } from "../src/runtime/presence.js";
import { seedUser, uniq } from "./auth-helpers.js";

// P3 T17: POST /__test/session seeds space roles (P5 contract).
const KEY = "k".repeat(32);
const TD = "p5.test";
const rl = { limit: async () => ({ success: true }) } as unknown as RateLimit;
const ON = {
  TEST_HOOKS: "1",
  TEST_HOOK_KEY: KEY,
  TEST_DOMAIN: TD,
  RL_ANON: rl,
  FEATURES: "spaces",
};
const on = (over: Partial<Env> = {}) => ({ ...env, ...ON, ...over }) as Env;
const tu = (local: string) => uniq(local, TD);
type Worker = typeof realWorker;

afterEach(() => {
  vi.doUnmock("@oa/shared");
  vi.resetModules();
});

async function call(
  e: Env,
  path: string,
  o: { method?: string; body?: unknown; cookie?: string; w?: Worker } = {},
) {
  return (o.w ?? realWorker).fetch(
    new Request(`http://app.localhost${path}`, {
      method: o.method ?? "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.210",
        // The hook key, or the session cookie (a bearer would read as a PAT).
        ...(o.cookie
          ? { cookie: `${sessionCookieName(env)}=${o.cookie}` }
          : { authorization: `Bearer ${KEY}` }),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    }) as never,
    e,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
}
const session = (e: Env, body: unknown, w?: Worker) =>
  call(e, TEST_HOOKS.session, { body, w });
const ref404 = async () =>
  (await call(env as Env, TEST_HOOKS.session, { body: {} })).text();
async function is404(r: Response) {
  expect(r.status).toBe(404);
  expect(await r.text()).toBe(await ref404());
}
const sid = () => `sp${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
async function myRole(e: Env, cookie: string, spaceId: string) {
  const r = await call(e, R.space(spaceId), { method: "GET", cookie });
  expect(r.status).toBe(200);
  return SpaceSchema.parse(await r.json()).myRole;
}
const revokedAt = (userId: string) => {
  const ns = env.USER_PRESENCE;
  if (!ns) throw new Error("USER_PRESENCE unbound");
  const stub = ns.get(
    ns.idFromName(userId),
  ) as unknown as DurableObjectStub<UserPresence>;
  return runInDurableObject(stub, (p) => p.revokedAt());
};
const memberRows = (spaceId: string) =>
  env.DB.prepare(
    "select role, source from space_members where space_id = ? order by role",
  )
    .bind(spaceId)
    .all<{ role: string; source: string }>()
    .then((r) => r.results);

describe("session hook with spaces", () => {
  it("session with spaces: the caller has that role", async () => {
    const [a, b, c] = [sid(), sid(), sid()];
    // b already exists (created by an admin, say); a and c are created.
    await env.DB.prepare(
      "insert into spaces (id, kind, name, all_members_role, public_links, created_at) values (?, 'shared', 'Existing', null, 1, ?)",
    )
      .bind(b, Date.now())
      .run();
    const r = await session(on(), {
      email: tu("sp"),
      role: "member",
      spaces: [
        { spaceId: a, role: "viewer" },
        { spaceId: b, role: "editor" },
        { spaceId: c, role: "manager" },
      ],
    });
    expect(r.status).toBe(200);
    const { cookie } = TestSessionResultSchema.parse(await r.json());
    expect(await myRole(on(), cookie, a)).toBe("viewer");
    expect(await myRole(on(), cookie, b)).toBe("editor");
    expect(await myRole(on(), cookie, c)).toBe("manager");
    expect(await memberRows(a)).toEqual([{ role: "viewer", source: "manual" }]);
    // The existing space is joined, not rewritten.
    expect(
      await env.DB.prepare("select name, public_links from spaces where id = ?")
        .bind(b)
        .first(),
    ).toEqual({ name: "Existing", public_links: 1 });
  });

  it("a second session upserts the manual row; only a lowering revokes live access", async () => {
    const s = sid();
    const email = tu("up");
    const grant = async (role: "viewer" | "editor") =>
      expect(
        (
          await session(on(), {
            email,
            role: "member",
            spaces: [{ spaceId: s, role }],
          })
        ).status,
      ).toBe(200);
    await grant("viewer");
    const userId = (await env.DB.prepare("select id from users where email = ?")
      .bind(email)
      .first("id")) as string;
    await grant("editor");
    expect(await memberRows(s)).toEqual([{ role: "editor", source: "manual" }]);
    expect(await revokedAt(userId)).toBeNull();
    await grant("viewer");
    expect(await memberRows(s)).toEqual([{ role: "viewer", source: "manual" }]);
    expect(await revokedAt(userId)).not.toBeNull();
  });

  it("TEST_HOOKS unset → 404", async () => {
    const s = sid();
    await is404(
      await session(on({ TEST_HOOKS: undefined }), {
        email: tu("off"),
        role: "member",
        spaces: [{ spaceId: s, role: "manager" }],
      }),
    );
    expect(
      await env.DB.prepare("select 1 from spaces where id = ?").bind(s).first(),
    ).toBeNull();
  });

  it("TEST_HOOKS=1 but TEST_HOOKS_ALLOWED false → 404", async () => {
    vi.resetModules();
    vi.doMock("@oa/shared", async (orig) => ({
      ...(await orig<typeof import("@oa/shared")>()),
      TEST_HOOKS_ALLOWED: false,
    }));
    const w = (await import("../src/index.js")).default;
    const s = sid();
    const r = await session(
      on(),
      {
        email: tu("rel"),
        role: "member",
        spaces: [{ spaceId: s, role: "manager" }],
      },
      w,
    );
    expect(r.status).toBe(404);
    expect(
      await env.DB.prepare("select 1 from spaces where id = ?").bind(s).first(),
    ).toBeNull();
  });

  // Plan says 400; P2's hook contract makes every refusal the standard 404.
  it("unknown role → the standard 404 (P2: every refusal is the 404)", async () => {
    await is404(
      await session(on(), {
        email: tu("bad"),
        role: "member",
        spaces: [{ spaceId: sid(), role: "owner" }],
      }),
    );
  });

  it("over 20 spaces, a repeated id or an unsafe id → 404", async () => {
    const many = Array.from({ length: 21 }, () => ({
      spaceId: sid(),
      role: "viewer",
    }));
    const s = sid();
    for (const spaces of [
      many,
      [
        { spaceId: s, role: "viewer" },
        { spaceId: s, role: "manager" },
      ],
      [{ spaceId: "a/b", role: "viewer" }],
      [{ spaceId: "", role: "viewer" }],
    ])
      await is404(
        await session(on(), { email: tu("lim"), role: "member", spaces }),
      );
    expect(
      (
        await session(on(), {
          email: tu("twenty"),
          role: "member",
          spaces: many.slice(0, 20),
        })
      ).status,
    ).toBe(200);
  });

  it("a personal or deleted space is refused and gains no member", async () => {
    const ownerId = await seedUser(tu("pers"), "member");
    const personal = (await env.DB.prepare(
      "select id from spaces where kind = 'personal' and owner_user_id = ?",
    )
      .bind(ownerId)
      .first("id")) as string;
    expect(personal).toBeTruthy();
    const gone = sid();
    await env.DB.prepare(
      "insert into spaces (id, kind, name, all_members_role, public_links, created_at, deleted_at) values (?, 'shared', 'Gone', null, 0, ?, ?)",
    )
      .bind(gone, Date.now(), Date.now())
      .run();
    const email = tu("intruder");
    for (const spaceId of [personal, gone]) {
      const fresh = sid();
      await is404(
        await session(on(), {
          email,
          role: "member",
          spaces: [
            { spaceId: fresh, role: "viewer" },
            { spaceId, role: "manager" },
          ],
        }),
      );
      // Refused as a whole: no rows anywhere, the fresh space not created.
      expect(
        await env.DB.prepare(
          "select count(*) n from space_members m join users u on u.id = m.user_id where u.email = ?",
        )
          .bind(email)
          .first("n"),
      ).toBe(0);
      expect(
        await env.DB.prepare("select 1 from spaces where id = ?")
          .bind(fresh)
          .first(),
      ).toBeNull();
    }
  });
});
