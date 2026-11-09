// #1299 (PR 2): the billing gate on the bus's configuration surfaces. Under a
// plan cap (hosted billing's lock on a non-owner) existing machines keep
// working, but approving a machine, confirming a role or a link, proposing
// either, and saving share notices are refused; revoking and every read stay
// open. A suspension blocks more: canConnect is false, so the member's
// machines are refused at connect too (401) and their share notices stop. The owner, an uncapped member and a
// self-hosted install (no plan at all) are unchanged.
//
// The bus is off on hosted until the gate lift (busOn needs HOSTED != "1" or
// FEATURES with "bus"), so these tests run a hosted install with the bus
// feature on, which is how the routes will behave after the lift.
import { env } from "cloudflare:workers";
import {
  BUS_ROUTES,
  decodeServerFrame,
  newMachineToken,
} from "@oa/bus-protocol";
import { type BusNotice, newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import {
  callerOf,
  capOfCaller,
  withCap,
  withPlan,
} from "../../src/auth/authz.js";
import { createPat } from "../../src/auth/pat.js";
import { sessionCookieName, signSession } from "../../src/auth/session.js";
import { busConfigCap, busConfigRefusal } from "../../src/bus/cap.js";
import { ROLE_CONFIRM_SCOPE } from "../../src/bus/role-confirm.js";
import { APPROVE_SCOPE } from "../../src/bus/routes.js";
import { formCsrf } from "../../src/http/pages.js";
import { installDelivery } from "../../src/services/bus-delivery.js";
import { setShareNotices } from "../../src/services/follows.js";
import { sha256Hex } from "../../src/util/crypto.js";
import {
  type BillingRow,
  cachePlan,
  clearBilling,
  DAY,
  fakeBilling,
  H as HOSTED_H,
  send,
} from "../billing-helpers.js";
import { fetchAndWait, login } from "../helpers.js";
import { connect, textOf, tool } from "../mcp-helpers.js";
import { pinMiddayUtc } from "../midday.js";
import {
  daemon,
  hello,
  hubOf,
  ns,
  trackSocket,
  up,
  waitFor,
} from "./helpers.js";

/** A hosted install with the bus feature on (FEATURES "bus"). */
const H = {
  ...HOSTED_H,
  FEATURES: `${HOSTED_H.FEATURES},bus`,
} as typeof HOSTED_H;
const app = createApp();
const APP = "http://app.localhost";
const { s: fake, props } = fakeBilling();
const tag = newId().slice(0, 6).toLowerCase();
let ip = 0;
let nameSeq = 0;
const uniq = (t: string) => `${t}-${++nameSeq}x${Date.now() % 1e8}`;
const nextIp = () => `198.51.100.${(++ip % 250) + 1}`;

/** GET /bus/connect on the hosted install with the machine token. */
const openSocket = (token: string) =>
  fetchAndWait(
    app,
    new Request(`${APP}${BUS_ROUTES.connect}`, {
      headers: {
        Upgrade: "websocket",
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": nextIp(),
      },
    }),
    H,
    props,
  );

const base = { trialEndsAt: 1, graceUntil: null, version: 1 };
const LOCKS: Record<string, BillingRow> = {
  // A trial answer with no end date counts as ended (a passed date is Solo, #1756).
  trial_ended: { ...base, trialEndsAt: null, tier: "trial", status: "active" },
  lapsed: { ...base, tier: "team", status: "lapsed" },
  payment_failed: { ...base, tier: "team", status: "past_due", graceUntil: 1 },
};
const SUSPENDED: BillingRow = { ...base, tier: "team", status: "suspended" };
const PAID: BillingRow = { ...base, tier: "business", status: "active" };

type U = { cookie: string; userId: string };
let owner: U;
let member: U;
let mid = 0;

/** A cookie for `uid` from a browser that has just signed in (the confirm pages need it). */
async function fresh(uid: string): Promise<string> {
  const row = await env.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(uid)
    .first<{ e: number }>();
  const now = Date.now();
  return `${sessionCookieName(env)}=${await signSession(env, uid, now, {
    provider: "access",
    epoch: row?.e ?? 0,
    authAt: now,
  })}`;
}

const lockTo = async (row: BillingRow) => {
  await clearBilling();
  await cachePlan({ ...row, version: row.version + 1 }, mid);
};

beforeAll(async () => {
  mid = pinMiddayUtc();
  owner = await login(`bo-${tag}@a.com`, "owner");
  member = await login(`bm-${tag}@a.com`, "member");
});
afterAll(async () => {
  vi.useRealTimers();
  await clearBilling();
});

// ---- the surfaces, each as one request that would change something

/** A device code the member could approve. */
async function startDevice(e: unknown = H): Promise<string> {
  const r = await fetchAndWait(
    app,
    new Request(`${APP}${BUS_ROUTES.device}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": nextIp(),
      },
      body: JSON.stringify({ machine_label: "plan-box" }),
    }),
    e,
    props,
  );
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { user_code: string }).user_code;
}
const approvedAt = async (code: string) =>
  (
    await env.DB.prepare(
      "select approved_at a from bus_device_codes where user_code = ?",
    )
      .bind(code)
      .first<{ a: number | null }>()
  )?.a ?? null;

async function formPost(
  path: string,
  who: U,
  fields: Record<string, string>,
  e = H,
) {
  const body = new URLSearchParams(fields).toString();
  return fetchAndWait(
    app,
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        cookie: who.cookie,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        "cf-connecting-ip": nextIp(),
      },
      body,
    }),
    e,
    props,
  );
}

const approveDecide = async (who: U) => {
  const code = await startDevice();
  const csrf = await formCsrf(H, APPROVE_SCOPE, who.userId, code);
  const r = await formPost("/bus/approve", who, {
    csrf,
    step: "decide",
    code,
    decision: "approve",
  });
  return { r, code };
};

/** POST /bus/roles/confirm or /bus/links/confirm as the card's script does (a fresh sign-in). */
async function confirmPost(
  path: string,
  scope: string,
  who: U,
  badCsrf = false,
) {
  const secret = "A".repeat(43);
  const cookie = await fresh(who.userId);
  const csrf = badCsrf
    ? "expired"
    : await formCsrf(H, scope, who.userId, await sha256Hex(secret));
  const text = JSON.stringify({ secret, csrf, decision: "confirm" });
  return fetchAndWait(
    app,
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(text).length),
      },
      body: text,
    }),
    H,
    props,
  );
}
const confirmRole = (who: U) =>
  confirmPost("/bus/roles/confirm", ROLE_CONFIRM_SCOPE, who);
const confirmLink = (who: U) =>
  confirmPost("/bus/links/confirm", "bus-link-confirm", who);
const confirmReach = (who: U) =>
  confirmPost("/bus/reach/confirm", "bus-reach-confirm", who);

/** A machine token for `who`, as the CLI holds it. */
async function machineToken(who: U): Promise<string> {
  const token = newMachineToken();
  await env.DB.prepare(
    "insert into bus_machines (id, user_id, label, token_hash, created_at) values (?, ?, ?, ?, ?)",
  )
    .bind(newId(), who.userId, "plan-box", await sha256Hex(token), Date.now())
    .run();
  return token;
}
const proposeLink = async (who: U) =>
  fetchAndWait(
    app,
    new Request(`${APP}${R.busLinkProposals}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await machineToken(who)}`,
      },
      body: JSON.stringify({
        action: "link",
        a: "test.local/a",
        b: "test.local/b",
      }),
    }),
    H,
    props,
  );

const proposeReach = async (who: U) =>
  fetchAndWait(
    app,
    new Request(`${APP}${R.busReachProposals}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await machineToken(who)}`,
      },
      body: JSON.stringify({
        nativeRef: "r1",
        namespaces: ["test.local/b"],
      }),
    }),
    H,
    props,
  );

const SHARE = "bus-share-notices";
const saveShareNotices = async (who: U) =>
  formPost("/bus/share-notices", who, {
    csrf: await formCsrf(H, SHARE, who.userId, "share-notices"),
  });

const proposeRoleMcp = async (who: U) => {
  const pat = (await createPat(env, who.userId, "agent")).token;
  const client = await connect(pat, { env: H, props });
  try {
    return await tool(client, "bus_role_propose", {
      action: "clear",
      namespace: "test.local/ns",
      name: "lead",
    });
  } finally {
    await client.close();
  }
};

const revokeMachine = async (who: U) => {
  const id = newId();
  await env.DB.prepare(
    "insert into bus_machines (id, user_id, label, token_hash, created_at) values (?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      who.userId,
      "to-revoke",
      await sha256Hex(newMachineToken()),
      Date.now(),
    )
    .run();
  const r = await send(props, `${R.busMachines}/${id}`, who.cookie, {
    method: "DELETE",
    e: H,
  });
  return r;
};

const PLAN_TEXT = /read-only until the plan is paid|team plan/;

// ---- the capped member: every surface refuses, with the plan's own error

describe.each(Object.entries(LOCKS))(
  "a plan-capped member under %s",
  (_n, row) => {
    beforeAll(() => lockTo(row));

    it("cannot approve a machine: the decide step is refused and the code stays pending", async () => {
      const { r, code } = await approveDecide(member);
      expect(r.status).toBe(403);
      expect(await r.text()).toMatch(PLAN_TEXT);
      expect(await approvedAt(code)).toBeNull();
    });

    it("cannot confirm a role or a link", async () => {
      for (const post of [confirmRole, confirmLink, confirmReach]) {
        const r = await post(member);
        expect(r.status, await r.clone().text()).toBe(403);
        // A card the page shows as it is, keeping the link's secret.
        expect(r.headers.get("content-type")).toContain("application/json");
        const card = (await r.json()) as { html: string; keep: boolean };
        expect(card.html).toMatch(PLAN_TEXT);
        expect(card.keep).toBe(true);
      }
    });

    it("cannot propose a link with a machine token", async () => {
      const r = await proposeLink(member);
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        "plan_read_only",
      );
    });

    it("cannot propose reach with a machine token", async () => {
      const r = await proposeReach(member);
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        "plan_read_only",
      );
    });

    it("cannot propose a role over MCP", async () => {
      const r = await proposeRoleMcp(member);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^plan_(required|read_only):/);
    });

    it("cannot save share notices (page and REST)", async () => {
      const r = await saveShareNotices(member);
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toBe("/bus?error=plan");
      const rest = await send(props, R.shareNotices, member.cookie, {
        method: "PUT",
        body: { addresses: [] },
        e: H,
      });
      expect(rest.status).toBe(403);
    });

    it("can still revoke a machine, and read the bus page and machine list", async () => {
      expect((await revokeMachine(member)).status).toBe(204);
      expect(
        (await send(props, R.busMachines, member.cookie, { e: H })).status,
      ).toBe(200);
      const page = await send(props, "/bus", member.cookie, { e: H });
      expect(page.status, await page.clone().text()).toBe(200);
    });

    it("keeps an existing machine connected: it upgrades and says hello", async () => {
      // Its own member: the hub limits how often one member's machines upgrade.
      const own = await login(`bc-${newId().slice(0, 8)}@a.com`, "member");
      const token = await machineToken(own);
      const res = await fetchAndWait(
        app,
        new Request(`${APP}${BUS_ROUTES.connect}`, {
          headers: {
            Upgrade: "websocket",
            authorization: `Bearer ${token}`,
            "cf-connecting-ip": nextIp(),
          },
        }),
        H,
        props,
      );
      expect(res.status).toBe(101);
      const ws = res.webSocket as WebSocket;
      ws.accept();
      trackSocket(ws);
      const first = new Promise<string>((resolve) =>
        ws.addEventListener("message", (ev) => resolve(String(ev.data))),
      );
      ws.send(
        JSON.stringify({
          v: 1,
          id: "h",
          type: "hello",
          machine_label: "plan-box",
          client_version: "0.0.0",
        }),
      );
      const d = decodeServerFrame(await first);
      expect(d.ok && d.frame.type).toBe("hello_ok");
      ws.close();
    });

    it("an existing machine still sends and receives a message", async () => {
      const own = await login(`bm-${newId().slice(0, 8)}@a.com`, "member");
      const d = await daemon(await machineToken(own), {}, (t) => openSocket(t));
      d.send(hello());
      await waitFor(d, "hello_ok");
      const space = ns("gate");
      d.send(up("ua", "ref-a", uniq("a"), space));
      const a = await waitFor(d, "agent_ok");
      d.send(up("ub", "ref-b", uniq("b"), space));
      const b = await waitFor(d, "agent_ok");
      d.send({
        v: 1,
        id: "s1",
        type: "send",
        from_ref: "ref-a",
        to_name: b.bus_name,
        body: "still working",
      });
      const got = await waitFor(d, "deliver");
      expect(got.to_ref).toBe("ref-b");
      expect(got.from_name).toBe(a.bus_name);
      expect(got.body).toBe("still working");
      d.close();
    });

    it("an existing share notice still delivers to the member's agent", async () => {
      // The server decides who gets a notice and hands it to the delivery
      // seam (services/bus-delivery.ts); the hub's delivery is not installed
      // yet, so a recording one stands in.
      const sent: { userId: string; notice: BusNotice }[] = [];
      const prev = installDelivery({
        async deliver(_e, userId, notice) {
          sent.push({ userId, notice });
          return "delivered";
        },
      });
      try {
        const email = `bn-${newId().slice(0, 8)}@a.com`;
        const own = await login(email, "member");
        const to = { namespace: ns("gate"), name: uniq("n") };
        // The notice was picked before the lock; it is not touched now.
        await setShareNotices(env as never, own.userId, [to]);
        const created = await send(props, R.artifacts, owner.cookie, {
          method: "POST",
          body: { title: "shared", format: "markdown", content: "hi" },
          e: H,
        });
        expect(created.status).toBe(201);
        const id = ((await created.json()) as { id: string }).id;
        const shared = await send(props, R.shares(id), owner.cookie, {
          method: "PUT",
          body: { email, role: "viewer" },
          e: H,
        });
        expect(shared.status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.userId).toBe(own.userId);
        expect(sent[0]?.notice.kind).toBe("shared");
        expect(sent[0]?.notice.to).toEqual(to);
        expect(sent[0]?.notice.artifactId).toBe(id);
      } finally {
        installDelivery(prev);
      }
    });
  },
);

// ---- #1346 role reach: a new grant is new configuration; removing one is not

describe.each(Object.entries(LOCKS))(
  "role reach for a plan-capped member under %s",
  (_n, row) => {
    it("cannot grant reach, but can still read and remove an existing grant", async () => {
      const who = await login(`br-${newId().slice(0, 8)}@a.com`, "member");
      await env.DB.prepare(
        "insert into bus_machines (id, user_id, label, token_hash, created_at, last_used_at) values (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          newId(),
          who.userId,
          "reach-box",
          await sha256Hex(newMachineToken()),
          Date.now(),
          Date.now(),
        )
        .run();
      const home = ns("gh");
      // Set up while on a paid plan: a role and one grant.
      await lockTo(PAID);
      const w = (path: string, method: string, body?: unknown) =>
        send(props, path, who.cookie, { method, body, e: H });
      expect(
        (
          await w(R.busRoles, "PUT", {
            namespace: home,
            name: "lead",
            agentId: null,
          })
        ).status,
      ).toBe(200);
      const made = await w(R.busReach, "PUT", {
        role: { namespace: home, name: "lead" },
        namespace: ns("gb"),
      });
      expect(made.status, await made.clone().text()).toBe(200);
      const { reach } = (await made.json()) as { reach: { id: string } };
      await lockTo(row);
      // A new grant: refused with the plan's own error; nothing is stored.
      const refused = await w(R.busReach, "PUT", {
        role: { namespace: home, name: "lead" },
        namespace: ns("gc"),
      });
      expect(refused.status).toBe(403);
      expect(
        ((await refused.json()) as { error: { code: string } }).error.code,
      ).toMatch(/^plan_(required|read_only)$/);
      const hub = await hubOf(who.userId);
      expect(await hub.listReach()).toHaveLength(1);
      // Reads and removal stay open.
      expect((await w(R.busReach, "GET")).status).toBe(200);
      expect((await w(R.busReachGrant(reach.id), "DELETE")).status).toBe(204);
      expect(await hub.listReach()).toEqual([]);
    });
  },
);

// ---- a suspension blocks more than the capped set

describe("a suspended member (an operator's stop)", () => {
  beforeAll(() => lockTo(SUSPENDED));

  it("cannot approve, confirm, propose or save share notices; nothing changes", async () => {
    const { r, code } = await approveDecide(member);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await approvedAt(code)).toBeNull();
    for (const post of [confirmRole, confirmLink, confirmReach]) {
      expect((await post(member)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await proposeLink(member)).status).toBeGreaterThanOrEqual(400);
    expect((await proposeReach(member)).status).toBeGreaterThanOrEqual(400);
    expect(
      (await proposeRoleMcp(member).catch(() => ({ isError: true }))).isError,
    ).toBe(true);
    expect((await saveShareNotices(member)).headers.get("location")).not.toBe(
      "/bus?done=saved",
    );
  });

  it("can still revoke", async () => {
    expect((await revokeMachine(member)).status).toBe(204);
  });

  it("an existing machine is refused at connect (401): suspension is not just the capped set", async () => {
    const own = await login(`bs-${newId().slice(0, 8)}@a.com`, "member");
    const res = await openSocket(await machineToken(own));
    expect(res.status).toBe(401);
  });

  it("the helper itself refuses a suspended plan-capped member", () => {
    // The cap is "plan" with a suspension lock: the same helper refusal as a lapse.
    expect(busConfigRefusal(capped("suspended"))?.code).toBe("plan_read_only");
  });
});

// ---- who is not affected

/** A member with the plan cap and a lock, as getUser builds one. */
function capped(status: "lapsed" | "suspended" | "free") {
  const m = withCap(
    { id: "u", email: "u@a.com", name: "u", role: "member" } as never,
    "plan",
  );
  return withPlan(m, {
    tier: status === "free" ? "free" : "team",
    status: status === "free" ? "active" : status,
    lock:
      status === "free"
        ? { mode: "solo", tier: "free", reason: "free" }
        : { mode: "read_only", tier: "team", reason: status },
  } as never);
}

describe("who the gate leaves alone", () => {
  beforeAll(() => lockTo(LOCKS.lapsed as BillingRow));

  it("the owner is never plan-capped: the same requests are not plan-refused", async () => {
    const { r, code } = await approveDecide(owner);
    expect(r.status).toBe(200);
    expect(await approvedAt(code)).not.toBeNull();
    for (const post of [confirmRole, confirmLink, confirmReach]) {
      expect(await (await post(owner)).text()).not.toMatch(PLAN_TEXT);
    }
    expect((await proposeLink(owner)).status).not.toBe(403);
    expect((await proposeReach(owner)).status).not.toBe(403);
    expect(textOf(await proposeRoleMcp(owner))).not.toMatch(
      /plan_(required|read_only)/,
    );
    expect((await saveShareNotices(owner)).headers.get("location")).toBe(
      "/bus?done=saved",
    );
  });

  it("an expired form token is a card that keeps the secret, with the real reason, on every flow", async () => {
    for (const [path, scope] of [
      ["/bus/roles/confirm", ROLE_CONFIRM_SCOPE],
      ["/bus/links/confirm", "bus-link-confirm"],
      ["/bus/reach/confirm", "bus-reach-confirm"],
    ] as const) {
      const r = await confirmPost(path, scope, owner, true);
      expect(r.status, path).toBe(403);
      expect(r.headers.get("content-type"), path).toContain("application/json");
      const card = (await r.json()) as { html: string; keep: boolean };
      expect(card.html, path).toContain("This page expired");
      expect(card.keep, path).toBe(true);
    }
  });

  it("an uncapped member (a paid plan) is not plan-refused either", async () => {
    await lockTo(PAID);
    const { r, code } = await approveDecide(member);
    expect(r.status).toBe(200);
    expect(await approvedAt(code)).not.toBeNull();
    for (const post of [confirmRole, confirmLink, confirmReach]) {
      expect(await (await post(member)).text()).not.toMatch(PLAN_TEXT);
    }
    expect((await proposeLink(member)).status).not.toBe(403);
    expect((await proposeReach(member)).status).not.toBe(403);
    expect(textOf(await proposeRoleMcp(member))).not.toMatch(
      /plan_(required|read_only)/,
    );
    expect((await saveShareNotices(member)).headers.get("location")).toBe(
      "/bus?done=saved",
    );
    await lockTo(LOCKS.lapsed as BillingRow);
  });

  it("self-host (no billing, so no plan and no cap) is unchanged", async () => {
    // The bus suites (roles/links proposals, bus.routes, bus.page) cover the
    // routes on self-host; here the helper and a plain env agree.
    const plain = await login(`sh-${tag}@a.com`, "member");
    const code = await startDevice(env);
    const csrf = await formCsrf(env, APPROVE_SCOPE, plain.userId, code);
    const body = new URLSearchParams({
      csrf,
      step: "decide",
      code,
      decision: "approve",
    }).toString();
    const r = await fetchAndWait(
      app,
      new Request(`${APP}/bus/approve`, {
        method: "POST",
        headers: {
          cookie: plain.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(body.length),
          "cf-connecting-ip": nextIp(),
        },
        body,
      }),
      env,
    );
    expect(r.status).toBe(200);
    expect(await approvedAt(code)).not.toBeNull();
    const m = withCap({ id: "u", role: "member" } as never, null);
    expect(busConfigRefusal(m)).toBeNull();
    expect(() => busConfigCap(m)).not.toThrow();
  });

  it("the helper refuses only the plan cap", () => {
    expect(capOfCaller(callerOf(capped("lapsed")))).toBe("plan");
    expect(busConfigRefusal(capped("lapsed"))?.code).toBe("plan_read_only");
    expect(busConfigRefusal(capped("free"))?.code).toBe("plan_required");
    expect(() => busConfigCap(capped("lapsed"))).toThrow();
    // Another cap (a guest's) is not this gate's concern: canConnect decides.
    expect(
      busConfigRefusal(withCap({ id: "g", role: "guest" } as never, "guest")),
    ).toBeNull();
  });
});

// ---- the flag: off on hosted is still a 404 on every bus route

describe("FEATURES bus", () => {
  it("hosted without the flag answers 404 on every bus route; with it, they answer", async () => {
    await lockTo(PAID);
    const off = { ...HOSTED_H } as typeof HOSTED_H;
    const on = H;
    const who = member;
    // (The REST list GETs under /api/v1/bus answer an empty list when the bus is off: unchanged.)
    const reqs: [string, string][] = [
      ["POST", BUS_ROUTES.device],
      ["POST", BUS_ROUTES.deviceToken],
      ["GET", "/bus/approve"],
      ["POST", "/bus/approve"],
      ["GET", BUS_ROUTES.connect],
      ["GET", "/bus"],
      ["POST", "/bus/share-notices"],
      ["GET", "/bus/roles/confirm"],
      ["POST", "/bus/roles/confirm"],
      ["GET", "/bus/links/confirm"],
      ["POST", "/bus/links/confirm"],
      ["POST", R.busLinkProposals],
      ["GET", "/bus/reach/confirm"],
      ["POST", "/bus/reach/confirm"],
      ["POST", R.busReachProposals],
    ];
    const hit = (e: typeof HOSTED_H, m: string, path: string) =>
      fetchAndWait(
        app,
        new Request(`${APP}${path}`, {
          method: m,
          headers: {
            cookie: who.cookie,
            "x-oa-request": "1",
            "cf-connecting-ip": nextIp(),
            "content-type": "application/json",
          },
          ...(m === "POST" ? { body: "{}" } : {}),
        }),
        e,
        props,
      );
    for (const [m, path] of reqs) {
      const r = await hit(off, m, path);
      expect(r.status, `${m} ${path} hosted, flag off`).toBe(404);
    }
    // Flag on: at least the entry points answer (not the bus-off 404).
    expect((await hit(on, "GET", "/bus")).status).toBe(200);
    expect((await hit(on, "GET", "/bus/approve")).status).toBe(200);
    await lockTo(LOCKS.lapsed as BillingRow);
  });

  it("self-host ignores the flag: the bus is on without it and with BUS_HUB unbound it is off", async () => {
    const { busOn } = await import("../../src/services/bus.js");
    expect(
      busOn({ BUS_HUB: env.BUS_HUB, HOSTED: undefined, FEATURES: "" }),
    ).toBe(true);
    expect(
      busOn({ BUS_HUB: undefined, HOSTED: undefined, FEATURES: "bus" }),
    ).toBe(false);
    expect(
      busOn({ BUS_HUB: env.BUS_HUB, HOSTED: "1", FEATURES: "spaces" }),
    ).toBe(false);
    expect(
      busOn({ BUS_HUB: env.BUS_HUB, HOSTED: "1", FEATURES: "spaces, bus" }),
    ).toBe(true);
  });
});

// keep the fake billing referenced for the gate props
void fake;
void DAY;
