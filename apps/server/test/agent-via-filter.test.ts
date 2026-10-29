// #589: `agentVia` filters the library and search by connection (a grant
// `g:<id>` or a token `t:<id>`), not by the self-reported client name that
// two connections can share. Honored only for the caller's own grant or
// token; any other via is an empty page (never 403 or 404), so ids can't be
// probed.
import { env } from "cloudflare:workers";
import {
  ListQuerySchema,
  type Member,
  newId,
  R,
  SearchQuerySchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { AgentAttr } from "../src/services/agent-usage.js";
import { listQuery, publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login, runIndex } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const WORD = `viafind${tag}`;

type U = { cookie: string; userId: string; member: Member };
let a: U;
let b: U;
const grant1 = newId();
const grant2 = newId();
const grantB = newId();
let tokenId: string;
let pat: string;
const ids: Record<string, string[]> = {};

async function mk(prefix: string): Promise<U> {
  const l = await login(`${prefix}-${tag}@x.com`);
  const member = await getUser(env, l.userId);
  if (!member) throw new Error("no user");
  return { ...l, member };
}

const claude = (grantId: string): AgentAttr => ({
  name: "Claude Code",
  version: "2.1",
  via: { kind: "grant", id: grantId },
});

async function pub(
  u: U,
  agent: AgentAttr | null,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { id } = await publish(
    env,
    u.member,
    {
      title,
      format: "html",
      content: `<p>${WORD} ${title}</p>`,
      ...extra,
    } as never,
    agent,
    undefined,
    "create",
  );
  return id;
}

async function addVersion(u: U, id: string, agent: AgentAttr | null) {
  await publish(
    env,
    u.member,
    { id, format: "html", content: `<p>${WORD} v2</p>` } as never,
    agent,
  );
}

const items = async (q: string, auth: string) => {
  const r = await api(app, `${R.artifacts}?limit=100&${q}`, auth);
  expect(r.status).toBe(200);
  return ((await r.json()) as { items: { id: string }[] }).items.map(
    (i) => i.id,
  );
};
const hits = async (q: string, auth: string) => {
  const r = await api(
    app,
    `${R.search}?q=${encodeURIComponent(WORD)}&limit=100&${q}`,
    auth,
  );
  expect(r.status).toBe(200);
  return ((await r.json()) as { items: { id: string }[] }).items.map(
    (i) => i.id,
  );
};
const via = (s: string) => `agentVia=${encodeURIComponent(s)}`;
const sorted = (x: string[]) => [...x].sort();

beforeAll(async () => {
  a = await mk("via-a");
  b = await mk("via-b");
  ({ id: tokenId, token: pat } = await createPat(env, a.userId, "via token"));
  ids.g1 = [
    await pub(a, claude(grant1), "g1 one"),
    await pub(a, claude(grant1), "g1 two", { format: "markdown" }),
  ];
  ids.g2 = [await pub(a, claude(grant2), "g2 one")];
  // One artifact with versions from both grants matches both.
  const both = await pub(a, claude(grant1), "both");
  await addVersion(a, both, claude(grant2));
  ids.both = [both];
  // The token: through REST, so agent_via is the real t:<tokenId>.
  const r = await api(app, R.artifacts, pat, {
    method: "POST",
    body: {
      title: "tok one",
      format: "html",
      content: `<p>${WORD} tok</p>`,
    },
  });
  expect(r.status).toBe(201);
  ids.tok = [((await r.json()) as { id: string }).id];
  ids.session = [await pub(a, null, "session")];
  // Another user's grant, on an artifact a can see (team).
  ids.b = [await pub(b, claude(grantB), "b team", { visibility: "team" })];
  for (const id of Object.values(ids).flat()) await runIndex(id);
});

describe("contract", () => {
  it("agentVia is g:<id> or t:<id>; anything else is invalid", () => {
    for (const ok of [`g:${grant1}`, `t:${newId()}`, "g:Ab_9-x"])
      expect(ListQuerySchema.safeParse({ agentVia: ok }).success).toBe(true);
    for (const bad of ["", "g:", "x:abc", "g:a b", "g:a%", "tabc", "g:a:b"]) {
      expect(ListQuerySchema.safeParse({ agentVia: bad }).success).toBe(false);
      expect(
        SearchQuerySchema.safeParse({ q: "a", agentVia: bad }).success,
      ).toBe(false);
    }
    expect(
      ListQuerySchema.safeParse({ agentVia: `g:${"a".repeat(65)}` }).success,
    ).toBe(false);
  });

  it("a malformed agentVia is 400 on list and search", async () => {
    expect(
      (await api(app, `${R.artifacts}?agentVia=nope`, a.cookie)).status,
    ).toBe(400);
    expect(
      (await api(app, `${R.search}?q=x&agentVia=nope`, a.cookie)).status,
    ).toBe(400);
  });
});

describe("list", () => {
  it("two grants with the same client name each filter to their own artifacts", async () => {
    expect(sorted(await items(via(`g:${grant1}`), a.cookie))).toEqual(
      sorted([...(ids.g1 ?? []), ...(ids.both ?? [])]),
    );
    expect(sorted(await items(via(`g:${grant2}`), a.cookie))).toEqual(
      sorted([...(ids.g2 ?? []), ...(ids.both ?? [])]),
    );
    // The name filter still mixes them (as before #589).
    const byName = await items("agent=Claude%20Code&scope=mine", a.cookie);
    for (const id of [...(ids.g1 ?? []), ...(ids.g2 ?? [])])
      expect(byName).toContain(id);
  });

  it("a token connection filters to its own artifacts", async () => {
    expect(await items(via(`t:${tokenId}`), a.cookie)).toEqual(ids.tok);
    expect(await items(via(`t:${tokenId}`), pat)).toEqual(ids.tok);
  });

  it("another user's via is an empty page, even on an artifact the caller can see", async () => {
    expect(await items("scope=all", a.cookie)).toContain(ids.b?.[0]);
    expect(await items(via(`g:${grantB}`), a.cookie)).toEqual([]);
    expect(await items(via(`g:${grant1}`), b.cookie)).toEqual([]);
    expect(await items(via(`t:${tokenId}`), b.cookie)).toEqual([]);
    // An unknown id reads the same as someone else's.
    expect(await items(via(`g:${newId()}`), a.cookie)).toEqual([]);
    expect(await items(via(`t:${newId()}`), a.cookie)).toEqual([]);
    // A grant id passed as a token (and the reverse) is not the caller's.
    expect(await items(via(`t:${grant1}`), a.cookie)).toEqual([]);
    expect(await items(via(`g:${tokenId}`), a.cookie)).toEqual([]);
    // The owner still gets their own.
    expect(await items(via(`g:${grantB}`), b.cookie)).toEqual(ids.b);
  });

  it("combines with the other filters", async () => {
    const g1 = `g:${grant1}`;
    expect(await items(`${via(g1)}&format=markdown`, a.cookie)).toEqual([
      ids.g1?.[1],
    ]);
    expect(
      await items(`${via(g1)}&q=${encodeURIComponent("two")}`, a.cookie),
    ).toEqual([ids.g1?.[1]]);
    expect(
      sorted(await items(`${via(g1)}&owner=me&scope=mine`, a.cookie)),
    ).toEqual(sorted([...(ids.g1 ?? []), ...(ids.both ?? [])]));
    expect(await items(`${via(g1)}&visibility=team`, a.cookie)).toEqual([]);
    expect(await items(`${via(g1)}&scope=shared`, a.cookie)).toEqual([]);
    expect(
      await items(`${via(g1)}&agent=${encodeURIComponent("Nobody")}`, a.cookie),
    ).toEqual([]);
    // Paging: limit 1 walks the same set.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await api(
        app,
        `${R.artifacts}?limit=1&${via(g1)}${cursor ? `&cursor=${cursor}` : ""}`,
        a.cookie,
      );
      const p = (await r.json()) as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      seen.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor;
    } while (cursor);
    expect(sorted(seen)).toEqual(
      sorted([...(ids.g1 ?? []), ...(ids.both ?? [])]),
    );
  });

  it("MCP list_artifacts takes agentVia (the shared schema)", () => {
    const p = ListQuerySchema.parse({ agentVia: `g:${grant1}` });
    expect(p.agentVia).toBe(`g:${grant1}`);
    // The key is last: existing keys keep their order.
    expect(Object.keys(ListQuerySchema.shape).at(-1)).toBe("agentVia");
  });
});

describe("search", () => {
  it("narrows hits to the caller's connection", async () => {
    const all = await hits("", a.cookie);
    expect(all).toEqual(expect.arrayContaining(ids.g2 ?? []));
    expect(sorted(await hits(via(`g:${grant2}`), a.cookie))).toEqual(
      sorted([...(ids.g2 ?? []), ...(ids.both ?? [])]),
    );
    expect(await hits(via(`t:${tokenId}`), a.cookie)).toEqual(ids.tok);
    expect(await hits(via(`g:${grantB}`), a.cookie)).toEqual([]);
    expect(await hits(via(`g:${grant1}`), b.cookie)).toEqual([]);
    expect(Object.keys(SearchQuerySchema.shape).at(-1)).toBe("agentVia");
  });
});

describe("rows_read stays bounded by the page, not the library", () => {
  // ~300 artifacts across several owners and connections. The caller's
  // connection published a dense recent run; the EXISTS is keyed by
  // artifact_id (the versions PK), so the walk stops at the page.
  const run = async (
    caller: U,
    q: Record<string, unknown>,
  ): Promise<{ n: number; read: number }> => {
    const s = listQuery(
      env,
      { kind: "user", user: caller.member },
      ListQuerySchema.parse(q),
    ).toSQL();
    const r = await env.DB.prepare(s.sql)
      .bind(...s.params)
      .all();
    return { n: r.results.length, read: r.meta.rows_read };
  };

  it("a 25-row page reads a bounded number of rows", async () => {
    const owners = [await mk("via-rows-1"), await mk("via-rows-2")];
    const caller = await mk("via-rows-c");
    const g = newId();
    const gOther = newId();
    const stmts: D1PreparedStatement[] = [];
    let t = Date.now() - 10_000_000;
    const seed = (owner: U, v: string | null, visibility = "team") => {
      const id = newId();
      t += 1000;
      stmts.push(
        env.DB.prepare(
          `insert into artifacts (id, owner_id, space_id, title, format, visibility, current_version, created_at, updated_at)
           values (?, ?, ?, ?, 'html', ?, 1, ?, ?)`,
        ).bind(id, owner.userId, owner.userId, `r ${id}`, visibility, t, t),
        env.DB.prepare(
          `insert into versions (artifact_id, version, entry, agent_name, agent_via, created_by, created_at, format)
           values (?, 1, 'index.html', 'Claude Code', ?, ?, ?, 'html')`,
        ).bind(id, v, owner.userId, t),
      );
    };
    // Older: other owners' team artifacts and the caller's other connection.
    for (let i = 0; i < 100; i++) seed(owners[i % 2] as U, `g:${newId()}`);
    for (let i = 0; i < 100; i++) seed(caller, `g:${gOther}`, "private");
    // Newest: 60 from the measured connection, interleaved with 40 others.
    for (let i = 0; i < 100; i++)
      if (i % 5 < 3) seed(caller, `g:${g}`, "private");
      else seed(owners[i % 2] as U, `g:${newId()}`);
    stmts.push(
      env.DB.prepare(
        "insert into agent_grants (grant_id, user_id) values (?, ?), (?, ?)",
      ).bind(g, caller.userId, gOther, caller.userId),
    );
    await env.DB.batch(stmts);

    const mine = (limit: number, agentVia?: string) =>
      run(caller, { scope: "mine", limit, agentVia });
    const dense = `g:${g}`;
    for (const limit of [10, 25, 50]) {
      const base = await mine(limit);
      const page = await mine(limit, dense);
      expect(page.n).toBe(limit + 1);
      // The walk stops at the page: the EXISTS adds about one versions PK
      // probe per row walked (measured 60 -> 84, 135 -> 189 and 260 -> 364
      // for limits 10, 25 and 50). A walk of the caller's 200 artifacts
      // reads over 600 (642, the no-match case below).
      expect(page.read).toBeLessThanOrEqual(2 * base.read);
    }
    // What the bound catches: a via with no matches walks every candidate.
    const none = await mine(25, `g:${newId()}`);
    expect(none.n).toBe(0);
    expect(none.read).toBeGreaterThan(2 * (await mine(25)).read);
    // scope all: the unfiltered page already reads the caller's visible set
    // (the MULTI-INDEX OR sorts it), and the EXISTS adds only its probes
    // over the rows walked (measured: 1567 -> 1690). A versions scan per row
    // would add 300+ per row.
    const allBase = await run(caller, { scope: "all", limit: 25 });
    const all = await run(caller, { scope: "all", limit: 25, agentVia: dense });
    expect(all.n).toBe(26);
    expect(all.read - allBase.read).toBeLessThanOrEqual(250);
  });
});
