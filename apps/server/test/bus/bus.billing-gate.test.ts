// #1299 (PR 2): the billing gate on the bus's configuration surfaces. Under a
// plan cap (hosted billing's lock on a non-owner) existing machines keep
// working, but approving a machine, confirming a role or a link, proposing
// either, and saving share notices are refused; revoking and every read stay
// open. A suspension blocks the same set. The owner, an uncapped member and a
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
import { newId, R } from "@oa/shared";
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

/** A hosted install with the bus feature on. */
const H = {
  ...HOSTED_H,
  FEATURES: `${HOSTED_H.FEATURES},bus`,
} as typeof HOSTED_H;
const app = createApp();
const APP = "http://app.localhost";
const { s: fake, props } = fakeBilling();
const tag = newId().slice(0, 6).toLowerCase();
let ip = 0;
const nextIp = () => `198.51.100.${(++ip % 250) + 1}`;

const base = { trialEndsAt: 1, graceUntil: null, version: 1 };
const LOCKS: Record<string, BillingRow> = {
  trial_ended: { ...base, tier: "trial", status: "active" },
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
async function confirmPost(path: string, scope: string, who: U) {
  const secret = "A".repeat(43);
  const cookie = await fresh(who.userId);
  const csrf = await formCsrf(H, scope, who.userId, await sha256Hex(secret));
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
      for (const post of [confirmRole, confirmLink]) {
        const r = await post(member);
        expect(r.status, await r.clone().text()).toBe(403);
        expect(await r.text()).toMatch(PLAN_TEXT);
      }
    });

    it("cannot propose a link with a machine token", async () => {
      const r = await proposeLink(member);
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
  },
);

// ---- a suspension blocks the same set

describe("a suspended member (an operator's stop)", () => {
  beforeAll(() => lockTo(SUSPENDED));

  it("cannot approve, confirm, propose or save share notices; nothing changes", async () => {
    const { r, code } = await approveDecide(member);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await approvedAt(code)).toBeNull();
    for (const post of [confirmRole, confirmLink]) {
      expect((await post(member)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await proposeLink(member)).status).toBeGreaterThanOrEqual(400);
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

  it("the helper itself refuses a suspended plan-capped member", () => {
    // The cap is "plan" with a suspension lock: the same refusal as a lapse.
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
    for (const post of [confirmRole, confirmLink]) {
      expect(await (await post(owner)).text()).not.toMatch(PLAN_TEXT);
    }
    expect((await proposeLink(owner)).status).not.toBe(403);
    expect(textOf(await proposeRoleMcp(owner))).not.toMatch(
      /plan_(required|read_only)/,
    );
    expect((await saveShareNotices(owner)).headers.get("location")).toBe(
      "/bus?done=saved",
    );
  });

  it("an uncapped member (a paid plan) is not plan-refused either", async () => {
    await lockTo(PAID);
    const { r, code } = await approveDecide(member);
    expect(r.status).toBe(200);
    expect(await approvedAt(code)).not.toBeNull();
    for (const post of [confirmRole, confirmLink]) {
      expect(await (await post(member)).text()).not.toMatch(PLAN_TEXT);
    }
    expect((await proposeLink(member)).status).not.toBe(403);
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

// keep the fake billing referenced for the gate props
void fake;
void DAY;
