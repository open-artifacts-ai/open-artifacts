import { env } from "cloudflare:workers";
import { type BusNotice, type Member, newId } from "@oa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { AgentAttr } from "../src/services/agent-usage.js";
import { publish } from "../src/services/artifacts.js";
import {
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import { follow } from "../src/services/follows.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

// #2036: the agent that published a version is not told it changed.

const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

type Sent = { userId: string; notice: BusNotice };
class FakeBus implements NoticeDelivery {
  sent: Sent[] = [];
  async deliver(_e: Env, userId: string, notice: BusNotice) {
    this.sent.push({ userId, notice });
    return "delivered" as const;
  }
  names() {
    return this.sent
      .filter((s) => s.notice.kind === "changed")
      .map((s) => `${s.userId.slice(0, 4)}:${s.notice.to.name}`)
      .sort();
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(() => installDelivery(prev));
beforeEach(() => {
  bus.sent = [];
});

type U = { userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${newId().slice(0, 6).toLowerCase()}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const NS = "ns-self";
const IDENT = {
  identityId: "id-self-0001",
  namespace: NS,
  name: "Runner",
  kind: "claude-code",
};
const LINKED: AgentAttr = { name: "Runner", version: null, identity: IDENT };

type Hub = { at: Map<string, string>; mode: "ok" | "fail" };
/** A bus env whose hub knows which identity sits at each address. */
function busEnv(hub: Hub) {
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      identityOf: async (n: string, name: string) => {
        if (hub.mode === "fail") throw new Error("hub down");
        const identityId = hub.at.get(`${n}/${name}`);
        return identityId ? { identityId, kind: "claude-code" } : null;
      },
    }),
  };
  return { ...E, BUS_HUB: ns } as unknown as Env;
}

async function scene(mode: Hub["mode"] = "ok") {
  const owner = await mk("sn-owner");
  const other = await mk("sn-other");
  await E.DB.prepare(
    "insert into bus_machines (id, user_id, label, token_hash, created_at, last_used_at) values (?, ?, 'm', ?, ?, ?)",
  )
    .bind(newId(), owner.userId, newId(), Date.now(), Date.now())
    .run();
  const hub: Hub = { at: new Map([[`${NS}/Runner`, IDENT.identityId]]), mode };
  const e2 = busEnv(hub);
  const id = (
    await publish(
      E,
      owner.member,
      {
        title: "t",
        format: "markdown",
        content: "v1",
        visibility: "team",
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
  await follow(E, owner.userId, { namespace: NS, name: "Runner" }, id);
  await follow(E, owner.userId, { namespace: NS, name: "Sibling" }, id);
  await follow(E, other.userId, { namespace: NS, name: "Runner" }, id);
  const v2 = (agent: AgentAttr | null) =>
    publish(
      e2,
      owner.member,
      { id, format: "markdown", content: `v ${newId()}` } as never,
      agent,
    );
  bus.sent = [];
  return { owner, other, id, hub, v2 };
}

const who = (u: U, name: string) => `${u.userId.slice(0, 4)}:${name}`;

describe("a publisher is not told its own change (#2036)", () => {
  it("a linked agent skips itself; the same person's other agent and another person's same-named agent are told", async () => {
    const s = await scene();
    await s.v2(LINKED);
    expect(bus.names()).toEqual(
      [who(s.owner, "Sibling"), who(s.other, "Runner")].sort(),
    );
  });

  it("an agent with the same name but another identity is still told", async () => {
    const s = await scene();
    s.hub.at.set(`${NS}/Runner`, "id-someone-else");
    await s.v2(LINKED);
    expect(bus.names()).toContain(who(s.owner, "Runner"));
  });

  it("an unlinked agent or a web publish tells everyone, as before", async () => {
    const s = await scene();
    for (const a of [{ name: "Runner", version: null } as AgentAttr, null]) {
      bus.sent = [];
      await s.v2(a);
      expect(bus.names()).toEqual(
        [
          who(s.owner, "Runner"),
          who(s.owner, "Sibling"),
          who(s.other, "Runner"),
        ].sort(),
      );
    }
  });

  it("a failing hub falls back to telling everyone", async () => {
    const s = await scene("fail");
    await s.v2(LINKED);
    expect(bus.names()).toContain(who(s.owner, "Runner"));
  });

  it("a comment still notifies the publisher's agent", async () => {
    const s = await scene();
    await s.v2(LINKED);
    const { notifyCommented } = await import("../src/services/follows.js");
    bus.sent = [];
    await notifyCommented(E, s.id, 2, s.other.userId, Date.now() + 10 * 60_000);
    expect(
      bus.sent
        .filter((x) => x.notice.kind === "commented")
        .map((x) => x.userId),
    ).toContain(s.owner.userId);
  });
});
