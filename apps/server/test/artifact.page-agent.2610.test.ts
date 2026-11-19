import { env } from "cloudflare:workers";
import {
  type ArtifactSummary,
  type BusNotice,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
  type VersionInfo,
} from "@oa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import type { AgentAttr } from "../src/services/agent-usage.js";
import { publish } from "../src/services/artifacts.js";
import {
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import { addThread, type CommentWho } from "../src/services/comments.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { listenEachOther } from "./held-listens.js";
import { api, login } from "./helpers.js";

// #2610 (server half): GET R.artifact carries `pageAgent` for members only; a
// guest and a signed-out visitor get the person (by public name) and no agent
// anywhere; a new thread notifies the page's agent unless `notifyPageAgent: false`.

const E = env as unknown as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

class FakeBus implements NoticeDelivery {
  sent: { userId: string; notice: BusNotice }[] = [];
  async deliver(_e: Env, userId: string, notice: BusNotice) {
    this.sent.push({ userId, notice });
    return "delivered" as const;
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(() => installDelivery(prev));
beforeEach(async () => {
  bus.sent = [];
  await E.DB.prepare(
    "delete from counters where key like 'notice:mention:%'",
  ).run();
});

type U = { userId: string; member: Member; email: string; cookie: string };
async function mk(prefix: string, role: "member" | "guest" = "member") {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  return {
    ...l,
    email,
    member: (await getUser(E, l.userId)) as Member,
  } as U;
}
let owner: U;
let editor: U;
let guest: U;
beforeAll(async () => {
  owner = await mk("pa-owner");
  editor = await mk("pa-editor");
  guest = await mk("pa-guest", "guest");
  await E.DB.prepare(
    "update users set display_name = 'Olive Owner' where id = ?",
  )
    .bind(owner.userId)
    .run();
  await listenEachOther(E, [owner.userId, editor.userId]);
});

const LINKED: AgentAttr = {
  name: "Design",
  version: null,
  identity: {
    identityId: "id-pub-pa-1",
    namespace: "ns-o",
    name: "Design",
    kind: "claude-code",
  },
};
async function page(
  over: {
    publisher?: AgentAttr | null;
    visibility?: string;
    image?: boolean;
  } = {},
) {
  const a = await publish(
    E,
    owner.member,
    (over.image
      ? {
          title: "img",
          format: "image",
          entry: "a.svg",
          files: {
            "a.svg":
              '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
          },
          visibility: over.visibility ?? "private",
        }
      : {
          title: "doc",
          format: "html",
          content: "<p>x</p>",
          visibility: over.visibility ?? "private",
        }) as never,
    over.publisher === undefined ? LINKED : over.publisher,
    undefined,
    "create",
  );
  await putShare(E, owner.member, a.id, {
    email: editor.email,
    role: "editor",
  });
  return a.id;
}
const get = async (id: string, u: U | null) => {
  const r = await api(app, R.artifact(id), u?.cookie ?? null);
  expect(r.status).toBe(200);
  return (await r.json()) as ArtifactSummary & Record<string, unknown>;
};
const versions = async (id: string, u: U | null) =>
  (await (
    await api(app, R.versions(id), u?.cookie ?? null)
  ).json()) as VersionInfo[];

describe("GET artifact: pageAgent", () => {
  it("a member sees { key, name, for, me }; me is true only for the agent's own person", async () => {
    const id = await page();
    const o = await get(id, owner);
    expect(o.pageAgent).toEqual({
      key: expect.stringMatching(/^agent:[0-9a-f]{32}$/),
      name: "Design",
      for: "Olive Owner",
      me: true,
    });
    const e = await get(id, editor);
    expect(e.pageAgent).toEqual({ ...o.pageAgent, me: false });
    expect(JSON.stringify(e.pageAgent)).not.toContain("@");
  });

  it("absent for a page a person published, and for a web publish with no linked agent", async () => {
    const id = await page({ publisher: null });
    expect(await get(id, owner)).not.toHaveProperty("pageAgent");
    const unlinked = await page({
      publisher: { name: "Claude", version: null },
    });
    expect(await get(unlinked, owner)).not.toHaveProperty("pageAgent");
  });

  it("absent when the publishing agent's person can no longer open the page", async () => {
    const id = await page({ publisher: null });
    // The editor's agent publishes version 2.
    await publish(
      E,
      editor.member,
      { id, content: "<p>y</p>", format: "html" } as never,
      {
        ...LINKED,
        identity: { ...LINKED.identity, identityId: "id-pub-pa-2" },
      } as AgentAttr,
      undefined,
      "version",
    );
    expect((await get(id, owner)).pageAgent).toMatchObject({
      name: "Design",
      me: false,
    });
    await E.DB.prepare(
      "delete from shares where artifact_id = ?1 and email = ?2",
    )
      .bind(id, editor.email)
      .run();
    expect(await get(id, owner)).not.toHaveProperty("pageAgent");
  });

  it("a guest and a signed-out visitor get no agent anywhere, and the person by public name only", async () => {
    const id = await page({ visibility: "public" });
    for (const who of [guest, null]) {
      const a = await get(id, who);
      expect(a).not.toHaveProperty("pageAgent");
      expect(a.lastAgent).toBeNull();
      const v = await versions(id, who);
      expect(v.length).toBeGreaterThan(0);
      for (const x of v) expect(x.agent).toBeNull();
      const raw = JSON.stringify([a, v]);
      expect(raw).not.toContain("Design");
      expect(raw).not.toContain("id-pub-pa-1");
      expect(raw).not.toContain("animal");
    }
    // Signed out: the publisher's real name, never an email.
    const out = await versions(id, null);
    expect(out[0]?.createdBy).toMatchObject({
      name: "Olive Owner",
      email: null,
    });
    expect(JSON.stringify(out)).not.toContain(owner.email);
    // A member still sees the agent in the versions list.
    expect((await versions(id, editor))[0]?.agent?.name).toBeTruthy();
  });

  it("a signed-out visitor never gets the publisher's name when it is an address or empty", async () => {
    const id = await page({ visibility: "public" });
    await E.DB.prepare(
      "update users set display_name = null, name = ?1 where id = ?2",
    )
      .bind(owner.email, owner.userId)
      .run();
    try {
      const out = await versions(id, null);
      expect(out[0]?.createdBy.email).toBeNull();
      expect(out[0]?.createdBy.name).toBeNull();
      expect(JSON.stringify(out)).not.toContain(owner.email);
    } finally {
      await E.DB.prepare(
        "update users set display_name = 'Olive Owner' where id = ?",
      )
        .bind(owner.userId)
        .run();
    }
  });

  it("a token of a member and a capped caller: a restricted member gets none", async () => {
    const id = await page();
    const pat = (await createPat(E, owner.userId, "pa")).token;
    const t = await api(app, R.artifact(id), pat);
    expect(((await t.json()) as ArtifactSummary).pageAgent?.name).toBe(
      "Design",
    );
    const r = await mk("pa-restricted");
    await putShare(E, owner.member, id, { email: r.email, role: "viewer" });
    await E.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(r.userId)
      .run();
    const a = await get(id, r);
    expect(a).not.toHaveProperty("pageAgent");
    expect(a.lastAgent).toBeNull();
  });
});

describe("a new thread notifies the page's agent by default", () => {
  const typed = (u: U): CommentWho => ({
    kind: "user",
    id: u.userId,
    typed: true,
  });
  const view = (u: U) => ({ userId: u.userId, short: null, moderator: true });
  const post = (
    id: string,
    who: CommentWho,
    u: U,
    anchor: unknown,
    extra: Record<string, unknown> = {},
  ) =>
    addThread(
      E,
      { id, format: "html", currentVersion: 1 } as never,
      who,
      view(u),
      { anchor, body: "look", ...extra },
      { moderator: true },
    ) as Promise<Thread>;
  const toAgent = (id: string) =>
    bus.sent.filter(
      (x) => x.userId === owner.userId && x.notice.artifactId === id,
    );
  const ANCHORS = {
    note: { kind: "note" },
    text: { kind: "text", exact: "x", prefix: "", suffix: "" },
    pin: { kind: "pin", x: 0.5, y: 0.5 },
  } as const;

  it.each(Object.entries(ANCHORS))(
    "a %s thread notifies the agent and lists it as a participant",
    async (_k, anchor) => {
      const id = await page({ image: _k === "pin" });
      const t = await post(id, typed(editor), editor, anchor);
      expect(toAgent(id)).toHaveLength(1);
      expect(t.agents?.some((p) => p.name === "Design")).toBe(true);
    },
  );

  it.each(Object.entries(ANCHORS))(
    "notifyPageAgent: false on a %s thread notifies nobody and adds no participant",
    async (_k, anchor) => {
      const id = await page({ image: _k === "pin" });
      const t = await post(id, typed(editor), editor, anchor, {
        notifyPageAgent: false,
      });
      expect(toAgent(id)).toHaveLength(0);
      expect(t.agents?.some((p) => p.name === "Design") ?? false).toBe(false);
      expect(t.comments[0]?.body).toBe("look");
    },
  );

  it("an @mention of another agent still works with the chip removed", async () => {
    const id = await page();
    const t = await post(id, typed(owner), owner, ANCHORS.note, {
      notifyPageAgent: false,
    });
    expect(t.comments[0]?.body).toBe("look");
    expect(toAgent(id)).toHaveLength(0);
  });

  it("an agent's or a token's comment never wakes another person's page agent; a person's own note does", async () => {
    const id = await page();
    await post(id, { kind: "user", id: editor.userId }, editor, ANCHORS.note);
    expect(toAgent(id)).toHaveLength(0);
    await post(id, typed(owner), owner, ANCHORS.note);
    expect(toAgent(id)).toHaveLength(1);
  });

  it("the REST body takes notifyPageAgent and refuses a non-boolean", async () => {
    const id = await page();
    const send = (body: unknown) =>
      api(app, R.comments(id), owner.cookie, { method: "POST", body });
    const ok = await send({
      anchor: ANCHORS.note,
      body: "x",
      notifyPageAgent: false,
    });
    expect(ok.status).toBe(201);
    expect(toAgent(id)).toHaveLength(0);
    expect(
      (await send({ anchor: ANCHORS.note, body: "x", notifyPageAgent: "no" }))
        .status,
    ).toBe(400);
  });
});
