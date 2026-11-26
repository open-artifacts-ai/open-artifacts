/// <reference types="node" />
// #2577 end to end, on the real server (wrangler dev), through the API only:
// two members, A and B, each with a running bus agent, and a guest.
//   1. B in A's listens-to list: B's mention wakes A's agent.
//   2. An unlisted B's mention is held; A is told once.
//   3. A allows once, for this page, or for all pages until a chosen date.
//   4. A guest's mention never reaches A's agent.
//   5. With A's switch off, B gets 403 "Only answers ...".
//   6. askState matches each case.
// The agents are real daemon sockets on each member's hub; "woken" means a
// frame about the page arrived on A's socket.
import {
  type AllowResult,
  type ArtifactAgent,
  type HeldList,
  type Inbox,
  type ListensList,
  R,
} from "@oa/shared";
import type { Page } from "@playwright/test";
import { checkMemberComments } from "../staging/happy-path/member-comments";
import {
  approveMachine,
  freshSignInUrl,
  spendDeviceCodes,
} from "./bus-confirm";
import {
  APP,
  createToken,
  expect,
  freshEmail,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";
import { mcpWithToken } from "./mcp-client";

type Frame = Record<string, unknown>;

/** A daemon socket with one open agent that keeps every frame it is sent. */
async function agentSocket(token: string, namespace: string) {
  const ws = new (
    WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> },
    ) => WebSocket
  )(`${APP.replace("http", "ws")}/bus/connect`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const frames: Frame[] = [];
  const arrivals: { artifact_id?: string; comment_id?: string }[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (ev) => {
    const text = String(ev.data);
    if (!text.startsWith("{")) return;
    const frame = JSON.parse(text) as Frame;
    frames.push(frame);
    if (frame.type === "deliver" && frame.to_ref === "r1") {
      if (frame.meta) arrivals.push(frame.meta as (typeof arrivals)[number]);
      ws.send(JSON.stringify({ v: 1, type: "ack", msg_id: frame.msg_id }));
    }
    for (const w of waiters.splice(0)) w();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  const next = (pred: (f: Frame) => boolean, label: string): Promise<Frame> =>
    new Promise<Frame>((resolve, reject) => {
      const check = () => {
        const f = frames.find(pred);
        if (!f) return false;
        clearTimeout(timer);
        resolve(f);
        return true;
      };
      const onMsg = () => {
        if (!check()) waiters.push(onMsg);
      };
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onMsg);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`no ${label} frame`));
      }, 15_000);
      if (!check()) waiters.push(onMsg);
    });
  let seq = 0;
  ws.send(
    JSON.stringify({
      v: 1,
      id: "h",
      type: "hello",
      machine_label: "E2E laptop",
      client_version: "0.0.0",
      caps: ["roles", "rename", "follow", "notice_ack", "notice_meta"],
    }),
  );
  await next((f) => f.type === "hello_ok", "hello_ok");
  ws.send(
    JSON.stringify({
      v: 1,
      id: "u1",
      type: "agent_up",
      agent_ref: "r1",
      kind: "opencode",
      proposed_name: "e2e-agent",
      namespace,
      global: false,
    }),
  );
  const ok = await next((f) => f.type === "agent_ok", "agent_ok");
  return {
    name: String(ok.bus_name),
    /** Count server deliveries to this agent for this page. */
    seen: (pageId: string) =>
      arrivals.filter((n) => n.artifact_id === pageId).length,
    /** Round-trip through the hub so any earlier delivery on this socket has arrived. */
    flush: async () => {
      const id = `fence-${++seq}`;
      ws.send(JSON.stringify({ v: 1, id, type: "list", from_ref: "r1" }));
      await next((f) => f.type === "roster" && f.id === id, `roster(${id})`);
    },
    close: () => ws.close(),
  };
}

const H = { "X-OA-Request": "1" };

test.describe.configure({ mode: "default" });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "one browser is enough: the specs below are API calls on a real server",
);

let aEmail: string;
let bEmail: string;
let guestEmail: string;

let pa: Page;
let pb: Page;
let pg: Page;
let aPat = "";
let agentA: Awaited<ReturnType<typeof agentSocket>>;
let agentB: Awaited<ReturnType<typeof agentSocket>>;

/** A private page with B as editor and both agents following. Guest cases opt in. */
async function newPage(label: string, withGuest = false) {
  const { id } = await publishViaApi(aPat, {
    title: `req ${label} ${uniq()}`,
    format: "markdown",
    content: "x",
  });
  const shares = [{ email: bEmail, role: "editor" }];
  if (withGuest) shares.push({ email: guestEmail, role: "commenter" });
  for (const { email, role } of shares) {
    const r = await pa.request.put(`${APP}${R.shares(id)}`, {
      headers: H,
      data: { email, role },
    });
    expect(r.ok(), await r.text()).toBe(true);
  }
  // A mention makes an agent follow (#1535): each member mentions their own.
  const keyOf = async (p: Page, owner: "mine" | "theirs") =>
    (await agents(p, id)).find((a) =>
      owner === "mine" ? a.owner == null : a.owner != null,
    )?.key as string;
  const aKey = await keyOf(pa, "mine");
  const bKey = await keyOf(pb, "mine");
  expect(aKey, "A's agent is on A's list").toBeTruthy();
  expect(bKey, "B's agent is on B's list").toBeTruthy();
  await mention(pa, id, aKey, "A follows");
  await mention(pb, id, bKey, "B follows");
  // Both agents now show on both lists.
  await expect
    .poll(async () => (await agents(pb, id)).length, { timeout: 15_000 })
    .toBe(2);
  return { id, aKey, bKey };
}

const agents = async (p: Page, id: string): Promise<ArtifactAgent[]> => {
  const r = await p.request.get(`${APP}${R.artifactAgents(id)}`);
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as ArtifactAgent[];
};
const askStateOf = async (p: Page, id: string, key: string) =>
  (await agents(p, id)).find((a) => a.key === key)?.askState;

const post = (p: Page, id: string, body: string, key: string) =>
  p.request.post(`${APP}${R.comments(id)}`, {
    headers: H,
    data: { anchor: { kind: "note" }, body, mentions: [{ key }] },
  });
const mention = async (p: Page, id: string, key: string, body: string) => {
  const r = await post(p, id, body, key);
  expect(r.status(), await r.text()).toBe(201);
};

const held = async (id?: string) => {
  const r = await pa.request.get(`${APP}${R.agentAskHeld}`);
  expect(r.ok(), await r.text()).toBe(true);
  const all = ((await r.json()) as HeldList).requests;
  return id ? all.filter((x) => x.artifact.id === id) : all;
};
const requestItems = async (id: string) => {
  const r = await pa.request.get(`${APP}${R.meInbox}`);
  expect(r.ok(), await r.text()).toBe(true);
  const inbox = (await r.json()) as Inbox;
  return [...inbox.needsYou, ...inbox.later, ...inbox.updates].filter(
    (i) => i.kind === "request" && i.artifact?.id === id,
  );
};
const allow = (
  requestId: string,
  level: "once" | "page" | "all",
  items: { commentId: string; wordsHash: string }[],
  until?: number,
) =>
  pa.request.post(`${APP}${R.agentAskHeldAllow(requestId)}`, {
    headers: H,
    data: { level, items, until },
  });
const listens = async () =>
  (await (
    await pa.request.get(`${APP}${R.agentListens}`)
  ).json()) as ListensList;
const setSwitch = async (on: boolean) => {
  const r = await pa.request.put(`${APP}${R.agentRequests}`, {
    headers: H,
    data: { on },
  });
  expect(r.ok(), await r.text()).toBe(true);
};
/** Waits for A's agent to be sent something about the page. */
const woken = async (id: string, before: number) =>
  expect
    .poll(() => agentA.seen(id), { timeout: 15_000 })
    .toBeGreaterThan(before);
/**
 * Nothing about the page reached A's agent. The server's window for this is
 * not a time: a mention that A's agent is not to hear is dropped from the
 * delivery list (held, services/comments.ts) or refused (403 for a guest or a
 * switched-off person) before the POST answers, so no send is ever started.
 * The caller has already seen that outcome on the response or the held list
 * (the end event); this then fences the socket, so anything sent earlier has
 * arrived, and checks the count.
 */
const quiet = async (id: string, before: number) => {
  await agentA.flush();
  expect(agentA.seen(id)).toBe(before);
};

test.beforeEach(async ({ browser }) => {
  test.setTimeout(180_000);
  const open = async (email: string, role: "member" | "guest") => {
    const ctx = await browser.newContext({ baseURL: APP });
    const p = await ctx.newPage();
    // Interactive-session routes (held requests, listens-to) refuse a plain
    // dev login (403 "Use the web app"); a ?fresh=1 sign-in is interactive.
    const fresh = await p.request.get(freshSignInUrl(email, "/", role), {
      maxRedirects: 0,
    });
    expect(fresh.status(), await fresh.text()).toBe(302);
    // The fresh sign-in resets the dev display name; set it again.
    const me = await p.request.patch(`${APP}${R.me}`, {
      headers: { "X-OA-Request": "1" },
      data: { displayName: `E2E ${email.split("@")[0]}` },
    });
    expect(me.ok(), await me.text()).toBe(true);
    const profile = await p.request.get(`${APP}${R.me}`);
    expect((await profile.json()).user.role).toBe(role);
    return p;
  };
  aEmail = freshEmail("req-a");
  bEmail = freshEmail("req-b");
  guestEmail = freshEmail("req-g");
  pa = await open(aEmail, "member");
  pb = await open(bEmail, "member");
  pg = await open(guestEmail, "guest");
  aPat = await createToken(pa);
  const ns = `e2e.local/${uniq()}`;
  agentA = await agentSocket(await approveMachine(pa), `${ns}-a`);
  agentB = await agentSocket(await approveMachine(pb), `${ns}-b`);
  expect(agentA.name).toBeTruthy();
  expect(agentB.name).toBeTruthy();
});

test.afterEach(async () => {
  await spendDeviceCodes();
  agentA?.close();
  agentB?.close();
  await Promise.all([pa, pb, pg].map((p) => p?.context().close()));
});

test("the staging two-PAT scenario works with two local members", async () => {
  const { id } = await publishViaApi(aPat, {
    title: `member comments ${uniq()}`,
    format: "markdown",
    content: "test",
    comments: true,
    visibility: "private",
  });
  const owner = await mcpWithToken(aPat);
  try {
    await checkMemberComments(APP, id, owner, aPat, await createToken(pb));
  } finally {
    await owner.close();
  }
});

test("2. an unlisted B's mention is held, nothing wakes A's agent, and A is told once", async () => {
  test.setTimeout(90_000);
  const { id, aKey } = await newPage("held");
  const before = agentA.seen(id);
  expect(await askStateOf(pb, id, aKey)).toBe("held");
  await mention(pb, id, aKey, "first question");
  await mention(pb, id, aKey, "second question");
  // The hold is the server's own record of the decision, made before the POST
  // answered: both mentions are on A's held list.
  const [r, ...rest] = await held(id);
  expect(rest).toHaveLength(0);
  expect(r?.items).toHaveLength(2);
  await quiet(id, before);
  expect(r?.sender.name).toBe(`E2E ${bEmail.split("@")[0]}`);
  expect(r?.items.map((i) => i.body)).toEqual([
    "first question",
    "second question",
  ]);
  // One inbox item for the person, however many comments.
  await expect.poll(async () => (await requestItems(id)).length).toBe(1);
  // What A's agent reads for the held comments is a placeholder.
  const seen = await pa.request.get(`${APP}${R.comments(id)}`, {
    headers: { authorization: `Bearer ${aPat}` },
  });
  expect(await seen.text()).not.toContain("first question");
});

test("3a. allow once passes exactly that comment; the next request is held again", async () => {
  test.setTimeout(90_000);
  const { id, aKey } = await newPage("once");
  await mention(pb, id, aKey, "only this one");
  await mention(pb, id, aKey, "not this one");
  const [r] = await held(id);
  const first = r?.items.find((i) => i.body === "only this one");
  const before = agentA.seen(id);
  const out = await allow(r?.id as string, "once", [
    {
      commentId: first?.commentId as string,
      wordsHash: first?.wordsHash as string,
    },
  ]);
  expect(out.status(), await out.text()).toBe(200);
  expect((await out.json()) as AllowResult).toEqual({
    sent: 1,
    changed: 0,
    waiting: 0,
  });
  await woken(id, before);
  // The other comment is still held, and B is not listed.
  const left = (await held(id))[0];
  expect(left?.items.map((i) => i.body)).toEqual(["not this one"]);
  expect(
    (await listens()).entries.filter((e) => e.artifact?.id === id),
  ).toHaveLength(0);
  expect(await askStateOf(pb, id, aKey)).toBe("held");
});

test("3b + 1. allow on this page for 30 days lists B; B's next mention wakes A's agent", async () => {
  test.setTimeout(90_000);
  const { id, aKey } = await newPage("page");
  await mention(pb, id, aKey, "let me in");
  const [r] = await held(id);
  const items = (r?.items ?? []).map((i) => ({
    commentId: i.commentId,
    wordsHash: i.wordsHash,
  }));
  const out = await allow(r?.id as string, "page", items);
  expect(out.status(), await out.text()).toBe(200);
  const entry = (await listens()).entries.find((e) => e.artifact?.id === id);
  expect(entry?.scope).toBe("page");
  expect(entry?.member.name).toBe(`E2E ${bEmail.split("@")[0]}`);
  const days = ((entry?.until ?? 0) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(29.9);
  expect(days).toBeLessThan(30.1);
  expect(await askStateOf(pb, id, aKey)).toBe("listening");
  const before = agentA.seen(id);
  await mention(pb, id, aKey, "now straight through");
  await woken(id, before);
  expect(await held(id)).toHaveLength(0);
  // Shorten, then remove: the next mention is held again, what came stays.
  const path = R.agentListen(entry?.id as string);
  const to = Date.now() + 86_400_000;
  const sh = await pa.request.patch(`${APP}${path}`, {
    headers: H,
    data: { until: to },
  });
  expect(sh.status(), await sh.text()).toBe(200);
  expect(((await sh.json()) as { until: number }).until).toBe(to);
  expect(
    (await pa.request.delete(`${APP}${path}`, { headers: H })).status(),
  ).toBe(204);
  expect(await askStateOf(pb, id, aKey)).toBe("held");
  await mention(pb, id, aKey, "after the removal");
  expect((await held(id))[0]?.items.map((i) => i.body)).toEqual([
    "after the removal",
  ]);
});

test("allow on all pages releases the request and wakes the agent on another private page until the chosen date", async () => {
  const original = await newPage("all");
  await mention(pb, original.id, original.aKey, "allow on all pages");
  const [request] = await held(original.id);
  expect(request?.items).toHaveLength(1);
  const until = Date.now() + 90 * 86_400_000;
  const before = agentA.seen(original.id);
  const out = await allow(
    request.id,
    "all",
    request.items.map(({ commentId, wordsHash }) => ({ commentId, wordsHash })),
    until,
  );
  expect(out.status(), await out.text()).toBe(200);
  expect(await out.json()).toMatchObject({ sent: 1, changed: 0, waiting: 0 });
  await woken(original.id, before);
  expect((await listens()).entries).toContainEqual(
    expect.objectContaining({ scope: "all", until }),
  );
  const next = await newPage("another private page");
  expect(await askStateOf(pb, next.id, next.aKey)).toBe("listening");
  const prior = agentA.seen(next.id);
  await mention(pb, next.id, next.aKey, "listed on another page");
  await woken(next.id, prior);
  expect(await held(next.id)).toHaveLength(0);
});

test("3c. Not now keeps the request held and quiets the sender: nothing wakes, no new notice, the asker sees no difference", async () => {
  test.setTimeout(90_000);
  const { id, aKey } = await newPage("notnow");
  await mention(pb, id, aKey, "pls");
  await expect.poll(async () => (await requestItems(id)).length).toBe(1);
  const [r] = await held(id);
  const before = agentA.seen(id);
  const nn = await pa.request.post(
    `${APP}${R.agentAskHeldNotNow(r?.id as string)}`,
    {
      headers: H,
    },
  );
  expect(nn.status(), await nn.text()).toBe(204);
  const after = (await held(id))[0];
  expect(after?.items).toHaveLength(1);
  expect(after?.quietUntil).toBeGreaterThan(Date.now());
  // Quiet means off Needs you for the day (inbox.ts heldRequestRows).
  expect((await requestItems(id)).length).toBe(0);
  await mention(pb, id, aKey, "pls again");
  expect((await held(id))[0]?.items).toHaveLength(2);
  await quiet(id, before);
  expect((await requestItems(id)).length).toBe(0);
  // B reads the same as before: still queued behind the hold.
  expect(await askStateOf(pb, id, aKey)).toBe("held");
});

test("4. a guest's mention never reaches A's agent, and is not held", async () => {
  test.setTimeout(90_000);
  const { id, aKey } = await newPage("guest", true);
  const before = agentA.seen(id);
  const r = await post(pg, id, "hello agent", aKey);
  expect([400, 403, 404]).toContain(r.status());
  expect(r.status(), await r.text()).not.toBe(201);
  // A guest's list holds no agent, so no askState either.
  expect(await agents(pg, id)).toEqual([]);
  await quiet(id, before);
  expect(await held(id)).toHaveLength(0);
});

test("5. with A's switch off, B gets 403 Only answers <A>; A's own agent still hears A", async () => {
  test.setTimeout(90_000);
  const { id, aKey } = await newPage("off");
  await setSwitch(false);
  try {
    expect(await askStateOf(pb, id, aKey)).toBe("off");
    const before = agentA.seen(id);
    const r = await post(pb, id, "anyone there?", aKey);
    expect(r.status()).toBe(403);
    expect(await r.text()).toContain(
      `Only answers E2E ${aEmail.split("@")[0]}`,
    );
    await quiet(id, before);
    expect(await held(id)).toHaveLength(0);
    // A's own agent is never gated.
    expect(await askStateOf(pa, id, aKey)).toBe("listening");
    const own = agentA.seen(id);
    await mention(pa, id, aKey, "note to self");
    await woken(id, own);
  } finally {
    await setSwitch(true);
  }
  expect(await askStateOf(pb, id, aKey)).toBe("held");
});

test("6. askState from each point of view", async () => {
  test.setTimeout(90_000);
  const { id, aKey, bKey } = await newPage("state", true);
  // B toward A: held. B toward B: listening. A toward B: held (B has not listed A). A toward A: listening.
  expect(await askStateOf(pb, id, aKey)).toBe("held");
  expect(await askStateOf(pb, id, bKey)).toBe("listening");
  expect(await askStateOf(pa, id, bKey)).toBe("held");
  expect(await askStateOf(pa, id, aKey)).toBe("listening");
  // The guest has no agent list, so no state.
  expect((await agents(pg, id)).map((a) => a.askState)).toEqual([]);
  await setSwitch(false);
  try {
    expect(await askStateOf(pb, id, aKey)).toBe("off");
    // The switch is A's: A's view of B's agent does not change.
    expect(await askStateOf(pa, id, bKey)).toBe("held");
  } finally {
    await setSwitch(true);
  }
});
