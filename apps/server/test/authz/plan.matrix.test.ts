// Self-serve billing: every caller on every write surface under each plan
// state, against a hand-written table. No lock (a paid or trial tier) is
// today's behaviour; under a lock (free and solo, or read-only) everyone but
// the org owner is read-only (403 plan_required / plan_read_only), the owner
// keeps their own personal artifacts and loses the team features, removals
// still pass, and anonymous data writes stop only while read-only. Reads
// pass in every state. Writes carry the CSRF header (cookie sessions), so a
// refusal is the plan's, never csrf.
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type BillingRow,
  cachePlan,
  clearBilling,
  DAY,
  fakeBilling,
  send,
} from "../billing-helpers.js";
import { login } from "../helpers.js";
import { pinMiddayUtc } from "../midday.js";

const tag = newId().slice(0, 6).toLowerCase();
const { props } = fakeBilling();

type Who = "owner" | "admin" | "member" | "anonymous";
type State = "none" | "solo" | "readOnly";
type U = { cookie: string; userId: string };
const users: Partial<Record<Exclude<Who, "anonymous">, U>> = {};
/** Each signed-in caller's own personal artifact (db, public, viewers write). */
const own: Partial<Record<Who, string>> = {};
let spaceId = "";
let seq = 0;
const uniq = () => `${tag}${++seq}`;

const ROWS: Record<State, BillingRow> = {
  none: {
    tier: "business",
    status: "active",
    trialEndsAt: null,
    graceUntil: null,
    version: 1,
  },
  // The trial already ran: a free instance is solo, invites need a plan.
  solo: {
    tier: "free",
    status: "active",
    trialEndsAt: 1,
    graceUntil: null,
    version: 2,
  },
  readOnly: {
    tier: "team",
    status: "lapsed",
    trialEndsAt: 1,
    graceUntil: null,
    version: 3,
  },
};
const CODE: Record<Exclude<State, "none">, string> = {
  solo: "plan_required",
  readOnly: "plan_read_only",
};

/** One write: the request for `who`. "team" marks a team feature. */
type Surface = {
  name: string;
  /** Who may do it with no lock (their role). */
  base: readonly Who[];
  /** A team feature: refused even for the owner under a lock. */
  team?: true;
  /** A removal: never refused by a lock. */
  removal?: true;
  /** Anonymous data write: refused only while read-only. */
  anonWrite?: true;
  run: (who: Who) => Promise<Response>;
};

const cred = (who: Who) =>
  who === "anonymous" ? null : (users[who] as U).cookie;
const art = (who: Who) => own[who === "anonymous" ? "owner" : who] as string;
const html = { format: "html", content: "<p>x</p>" };

const SURFACES: Surface[] = [
  {
    name: "publish a personal artifact",
    base: ["owner", "admin", "member"],
    run: (w) =>
      send(props, R.artifacts, cred(w), {
        method: "POST",
        body: { title: "t", ...html },
      }),
  },
  {
    name: "publish a version (own)",
    base: ["owner", "admin", "member"],
    run: (w) =>
      send(props, R.versions(art(w)), cred(w), { method: "POST", body: html }),
  },
  {
    name: "rename (own)",
    base: ["owner", "admin", "member"],
    run: (w) =>
      send(props, R.artifact(art(w)), cred(w), {
        method: "PATCH",
        body: { title: uniq() },
      }),
  },
  {
    name: "live-data write (own)",
    base: ["owner", "admin", "member"],
    run: (w) =>
      send(props, R.dataDoc(art(w), "c", "d"), cred(w), {
        method: "PUT",
        raw: '{"v":1}',
      }),
  },
  {
    name: "create an upload (own)",
    base: ["owner", "admin", "member"],
    run: (w) =>
      send(props, R.uploads, cred(w), {
        method: "POST",
        body: {
          artifactId: art(w),
          path: `${uniq()}.png`,
          size: 3,
          contentType: "image/png",
        },
      }),
  },
  {
    name: "create a token",
    base: ["owner", "admin", "member"],
    run: (w) =>
      send(props, R.tokens, cred(w), {
        method: "POST",
        body: { label: uniq() },
      }),
  },
  {
    name: "share with someone (own)",
    base: ["owner", "admin", "member"],
    team: true,
    run: (w) =>
      send(props, R.shares(art(w)), cred(w), {
        method: "PUT",
        body: { email: `s-${uniq()}@a.com`, role: "viewer" },
      }),
  },
  {
    name: "remove a share (own)",
    base: ["owner", "admin", "member"],
    removal: true,
    run: async (w) => {
      const email = `r-${uniq()}@a.com`;
      await env.DB.prepare(
        "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, 1)",
      )
        .bind(art(w), email, users.owner?.userId)
        .run();
      return send(props, R.share(art(w), email), cred(w), { method: "DELETE" });
    },
  },
  {
    name: "invite",
    base: ["owner", "admin"],
    team: true,
    run: (w) =>
      send(props, R.members, cred(w), {
        method: "POST",
        body: { email: `i-${uniq()}@a.com`, role: "member" },
      }),
  },
  {
    name: "remove a member",
    base: ["owner", "admin"],
    removal: true,
    run: async (w) => {
      const gone = await login(`g-${uniq()}@a.com`, "member");
      return send(props, R.member(gone.userId), cred(w), { method: "DELETE" });
    },
  },
  {
    name: "create a shared space",
    base: ["owner", "admin"],
    team: true,
    run: (w) =>
      send(props, R.spaces, cred(w), {
        method: "POST",
        body: { name: `S ${uniq()}` },
      }),
  },
  {
    name: "publish into a shared space",
    base: ["owner", "admin", "member"],
    team: true,
    run: (w) =>
      send(props, R.artifacts, cred(w), {
        method: "POST",
        body: { title: "t", ...html, spaceId },
      }),
  },
  {
    name: "live-data write on the owner's public page (viewers write)",
    base: ["owner", "admin", "member", "anonymous"],
    anonWrite: true,
    run: (w) =>
      send(props, R.dataDoc(own.owner as string, "votes", newId()), cred(w), {
        method: "PUT",
        raw: '{"v":1}',
        headers: { "cf-connecting-ip": `198.51.100.${(seq++ % 200) + 1}` },
      }),
  },
];

const CALLERS: readonly Who[] = ["owner", "admin", "member", "anonymous"];

/** The expected outcome: "allow", or the refusal code ("deny": any non-2xx). */
function expected(
  s: Surface,
  who: Who,
  state: State,
): "allow" | "deny" | string {
  if (!s.base.includes(who)) return "deny";
  if (state === "none") return "allow";
  // Anonymous visitors aren't capped: only read-only stops their data writes.
  if (s.anonWrite && who === "anonymous")
    return state === "readOnly" ? CODE.readOnly : "allow";
  // Everyone but the owner is read-only, removals included.
  if (who !== "owner") return CODE[state];
  if (s.removal) return "allow";
  return s.team ? CODE[state] : "allow";
}

beforeAll(async () => {
  pinMiddayUtc();
  await clearBilling();
  await cachePlan(ROWS.none);
  users.owner = await login(`owner-${tag}@a.com`, "owner");
  users.admin = await login(`admin-${tag}@a.com`, "admin");
  users.member = await login(`member-${tag}@a.com`, "member");
  for (const w of ["owner", "admin", "member"] as const) {
    const r = await send(props, R.artifacts, cred(w), {
      method: "POST",
      body: {
        title: `own ${w}`,
        ...html,
        visibility: "public",
        dataWriters: "viewers",
        capabilities: { db: true, viewer: false, storage: false },
      },
    });
    expect(r.status).toBe(201);
    own[w] = ((await r.json()) as { id: string }).id;
  }
  const sp = await send(props, R.spaces, cred("owner"), {
    method: "POST",
    body: { name: `Matrix ${tag}` },
  });
  expect(sp.status).toBe(201);
  spaceId = ((await sp.json()) as { id: string }).id;
  for (const w of ["admin", "member"] as const)
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', 1)",
    )
      .bind(spaceId, users[w]?.userId)
      .run();
}, 60_000);
afterAll(async () => {
  vi.useRealTimers();
  await clearBilling();
});

describe.each(["none", "solo", "readOnly"] as const)("plan %s", (state) => {
  beforeAll(async () => {
    await clearBilling();
    await cachePlan(ROWS[state]);
  });

  it.each(
    SURFACES.flatMap((s) => CALLERS.map((who) => [s.name, who] as const)),
  )("%s as %s", async (name, who) => {
    const s = SURFACES.find((x) => x.name === name) as Surface;
    const want = expected(s, who, state);
    const r = await s.run(who);
    const text = await r.text();
    if (want === "allow")
      expect([r.status, text]).toEqual([
        expect.toSatisfy((n: number) => n >= 200 && n < 300),
        text,
      ]);
    else if (want === "deny") expect(r.status).toBeGreaterThanOrEqual(400);
    else {
      expect(r.status).toBe(403);
      expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(
        want,
      );
    }
  });

  it("reads pass for everyone who could read", async () => {
    for (const w of ["owner", "admin", "member"] as const) {
      expect(
        (await send(props, R.artifact(own.owner as string), cred(w))).status,
      ).toBe(200);
      expect((await send(props, R.me, cred(w))).status).toBe(200);
    }
    expect(
      (await send(props, R.artifact(own.owner as string), null)).status,
    ).toBe(200);
  });
});

it("the expected table refuses every non-owner write and every owner team write under a lock", () => {
  for (const state of ["solo", "readOnly"] as const)
    for (const s of SURFACES)
      for (const who of ["admin", "member"] as const)
        if (s.base.includes(who))
          expect(expected(s, who, state)).toBe(CODE[state]);
  void DAY;
});

// S4: under a lock, the owner and admins can still pay and still see their
// instance (billing actions and admin READS); a member of a locked team is
// read-only with no billing access. Writes stay capped (the table above).
type Exempt = {
  name: string;
  run: (who: Who) => Promise<Response>;
  /** Who passes, in every state. */
  ok: readonly Who[];
};
const EXEMPT: Exempt[] = [
  {
    name: "billing checkout",
    ok: ["owner", "admin"],
    run: (w) =>
      send(props, R.billingCheckout, cred(w), {
        method: "POST",
        body: { tier: "team" },
      }),
  },
  {
    name: "billing portal",
    ok: ["owner", "admin"],
    run: (w) =>
      send(props, R.billingPortal, cred(w), { method: "POST", body: {} }),
  },
  {
    name: "billing usage report",
    ok: ["owner", "admin"],
    run: (w) =>
      send(props, R.billingUsage, cred(w), { method: "POST", body: {} }),
  },
  {
    name: "list members",
    ok: ["owner", "admin"],
    run: (w) => send(props, R.members, cred(w)),
  },
  {
    name: "read the audit log",
    ok: ["owner", "admin"],
    run: (w) => send(props, R.audit, cred(w)),
  },
  // A capped read (audit.read refuses any cap) that the plan cap exempts:
  // settings.read ignores caps altogether, so it would prove nothing.
  {
    name: "export the audit log",
    ok: ["owner", "admin"],
    run: (w) => send(props, R.auditExport, cred(w)),
  },
];

describe.each(["none", "solo", "readOnly"] as const)(
  "plan %s: billing and admin reads",
  (state) => {
    beforeAll(async () => {
      await clearBilling();
      await cachePlan(ROWS[state]);
    });

    it.each(
      EXEMPT.flatMap((s) => CALLERS.map((who) => [s.name, who] as const)),
    )("%s as %s", async (name, who) => {
      const s = EXEMPT.find((x) => x.name === name) as Exempt;
      const r = await s.run(who);
      const text = await r.text();
      if (s.ok.includes(who))
        expect([r.status, text]).toEqual([
          expect.toSatisfy((n: number) => n >= 200 && n < 300),
          text,
        ]);
      else if (who === "anonymous") expect(r.status).toBe(401);
      // A member: no billing access, ever (404, or the plan's 403 on a POST).
      else expect([403, 404]).toContain(r.status);
    });

    it("Me's billing details: the owner and admins, never a member", async () => {
      for (const w of ["owner", "admin", "member"] as const) {
        const r = await send(props, R.me, cred(w));
        const me = (await r.json()) as {
          instance: { billing?: { status: string | null } };
        };
        expect(me.instance.billing?.status ?? null).toBe(
          w === "member" ? null : ROWS[state].status,
        );
      }
    });

    it("an admin's writes stay capped under a lock (settings)", async () => {
      const patch = (w: Who) =>
        send(props, R.settings, cred(w), {
          method: "PATCH",
          body: { name: `M ${uniq()}` },
        });
      const a = await patch("admin");
      if (state === "none") expect(a.status).toBe(200);
      else {
        expect(a.status).toBe(403);
        expect(
          ((await a.json()) as { error: { code: string } }).error.code,
        ).toBe(CODE[state]);
      }
      expect((await patch("owner")).status).toBe(200);
    });
  },
);
