// #1346: propose_reach from an adapter. The daemon posts to the configured
// hub's reach route with this machine's token and the CALLING session's ref;
// the frame and the tool name no session. Fake fetch and hub; waits are
// signals (a frame, a promise), never sleeps.
import { ADAPTER_CAPS, type Hello } from "@oa/bus-ipc";
import { BUS_ROUTES } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTable } from "../src/agents.ts";
import {
  proposeReach,
  REACH_COPY,
  type ReachResult,
  reachUrl,
} from "../src/reach.ts";
import { Pending, type RouteCtx, routeLocal } from "../src/routes.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const TOKEN = "oa_machine_SECRETSECRETSECRET";
const SECRET = "A".repeat(43);
const HUB = "https://hub.test";
const CONFIRM = `${HUB}/bus/reach/confirm#${SECRET}`;
const EXP = "2026-11-09T11:00:00.000Z";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const conflict = (reason: string) =>
  json(409, { error: { code: "conflict", message: "x", details: { reason } } });

type Call = { url: string; init: RequestInit };
const fakeFetch = (answer: (c: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return answer(c);
  });
  return { calls, fetch: f as unknown as typeof fetch };
};
const ask = (
  f: typeof fetch,
  over: Partial<Parameters<typeof proposeReach>[0]> = {},
) =>
  proposeReach({
    hub: HUB,
    token: TOKEN,
    nativeRef: "sess-1",
    namespaces: ["a", "b"],
    fetch: f,
    ...over,
  });

describe("proposeReach: the request", () => {
  it("posts the session's ref and the namespaces to the hub's route with the machine token", async () => {
    const h = fakeFetch(() =>
      json(200, { confirmUrl: CONFIRM, expiresAt: EXP }),
    );
    expect(await ask(h.fetch)).toEqual({
      ok: true,
      confirmUrl: CONFIRM,
      expiresAt: EXP,
    });
    const [c] = h.calls;
    expect(c?.url).toBe(`${HUB}${BUS_ROUTES.reachProposals}`);
    expect(c?.init.method).toBe("POST");
    expect(c?.init.redirect).toBe("error");
    expect(c?.init.signal).toBeInstanceOf(AbortSignal);
    expect(
      ((c as Call).init.headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(c?.init.body))).toEqual({
      nativeRef: "sess-1",
      namespaces: ["a", "b"],
    });
  });

  it("derives the url from the configured hub, ws or http, like the socket", () => {
    for (const hub of ["wss://h.test", "https://h.test/", "https://h.test"])
      expect(reachUrl(hub)).toBe("https://h.test/api/v1/bus/reach/proposals");
    expect(reachUrl("ws://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787/api/v1/bus/reach/proposals",
    );
  });

  it("refuses a confirm link that is not the hub's own page", async () => {
    for (const confirmUrl of [
      `https://evil.test/bus/reach/confirm#${SECRET}`,
      `${HUB}/bus/links/confirm#${SECRET}`,
      `${HUB}/bus/reach/confirm?x=1#${SECRET}`,
      `${HUB}/bus/reach/confirm#short`,
      42,
    ]) {
      const r = await ask(
        fakeFetch(() => json(200, { confirmUrl, expiresAt: EXP })).fetch,
      );
      expect(r).toMatchObject({ ok: false, code: "bad_reply" });
    }
    expect(
      await ask(fakeFetch(() => json(200, { confirmUrl: CONFIRM })).fetch),
    ).toMatchObject({ ok: false, code: "bad_reply" });
  });
});

describe("proposeReach: responses", () => {
  const code = async (res: Response | (() => Response)) =>
    ask(fakeFetch(() => (typeof res === "function" ? res() : res)).fetch);

  it("maps the route's refusals to plain copy", async () => {
    for (const reason of [
      "no_role",
      "ambiguous",
      "rate_limited",
      "proposal_limit",
      "no_bus",
    ] as const)
      expect(await code(conflict(reason))).toEqual({
        ok: false,
        code: reason,
        message: REACH_COPY[reason],
      });
    expect(REACH_COPY.no_role).toMatch(/no role/i);
    expect(await code(conflict("something_new"))).toMatchObject({
      ok: false,
      code: "refused",
    });
  });

  it("401 says the token was not accepted; 404 says the hub is too old", async () => {
    expect(await code(json(401, { error: { code: "unauthorized" } }))).toEqual({
      ok: false,
      code: "unauthorized",
      message: REACH_COPY.unauthorized,
    });
    expect(await code(new Response("not found", { status: 404 }))).toEqual({
      ok: false,
      code: "unsupported",
      message: REACH_COPY.old_hub,
    });
  });

  it("a plan cap (403) shows the hub's own words and the status", async () => {
    const r = await code(
      json(403, {
        error: {
          code: "plan_read_only",
          message: "Team features are read-only until the plan is paid",
          details: { tier: "team", reason: "no_reach" },
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect((r as { message: string }).message).toContain(
      "Team features are read-only until the plan is paid",
    );
    expect((r as { message: string }).message).toContain("HTTP 403");
    // The plan's own `reason` is not mistaken for a conflict reason.
    expect((r as { message: string }).message).not.toBe(REACH_COPY.no_role);
  });

  it("a 402 and a 5xx are refusals with the status, and a junk body is not trusted", async () => {
    expect(await code(new Response("<html>", { status: 402 }))).toMatchObject({
      ok: false,
      message: expect.stringContaining("HTTP 402"),
    });
    expect(await code(new Response("oops", { status: 502 }))).toMatchObject({
      ok: false,
      message: expect.stringContaining("HTTP 502"),
    });
    expect(
      await code(new Response("x".repeat(20_000), { status: 200 })),
    ).toMatchObject({ ok: false, code: "bad_reply" });
  });
});

describe("proposeReach: failure and secrecy", () => {
  it("a network error or a redirect is a clear tool error, and the token is nowhere in it or the log", async () => {
    const logs: string[] = [];
    for (const err of [
      new TypeError(`fetch failed for Bearer ${TOKEN}`),
      Object.assign(new TypeError(`redirect ${TOKEN}`), {
        cause: { code: "x" },
      }),
    ]) {
      const r = await ask(
        fakeFetch(() => {
          throw err;
        }).fetch,
        { log: (l) => logs.push(l) },
      );
      expect(r).toEqual({
        ok: false,
        code: "hub_unavailable",
        message: REACH_COPY.down,
      });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
    expect(logs.length).toBe(2);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(HUB);
  });

  it("the hub's own message never carries the token out", async () => {
    const r = await ask(
      fakeFetch(() =>
        json(403, { error: { message: `bad ${TOKEN} here`, code: "x" } }),
      ).fetch,
    );
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("a hub that never answers is cut off by the timeout, not waited on", async () => {
    vi.useFakeTimers();
    try {
      const h = fakeFetch(
        (c) =>
          new Promise<Response>((_, reject) =>
            (c.init.signal as AbortSignal).addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          ),
      );
      const p = ask(h.fetch, { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await p).toEqual({
        ok: false,
        code: "hub_unavailable",
        message: REACH_COPY.down,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

const hello = (caps?: string[]): Hello =>
  ({
    v: 1,
    id: "hello",
    type: "hello",
    kind: "claude-code",
    agent_ref: "A",
    pid: 1,
    attest: {},
    ...(caps ? { caps } : {}),
  }) as unknown as Hello;

describe("propose_reach in routeLocal", () => {
  const setup = (answer: () => Promise<ReachResult>) => {
    const agents = new AgentTable();
    agents.up({
      ref: "A",
      kind: "claude-code",
      proposedName: "a",
      busName: "a",
      namespace: "ns",
      global: false,
      pid: 1,
      cwd: "/x",
      live: true,
    });
    const asked: { ref: string; namespaces: string[] }[] = [];
    const replies: Record<string, unknown>[] = [];
    const ctx = {
      agents,
      pending: new Pending(),
      hub: { send: () => true },
      proposeReach: (ref: string, namespaces: string[]) => {
        asked.push({ ref, namespaces });
        return answer();
      },
    } as unknown as RouteCtx;
    const route = (
      frame: Record<string, unknown>,
      h = hello([ADAPTER_CAPS.reach]),
    ) =>
      routeLocal(
        { v: 1, id: "7", type: "propose_reach", ...frame } as never,
        h,
        (f) => replies.push(f as never) > 0,
        ctx,
      );
    return { route, asked, replies };
  };
  const ok = async (): Promise<ReachResult> => ({
    ok: true,
    confirmUrl: CONFIRM,
    expiresAt: EXP,
  });

  it("asks as the connection's agent whatever the frame says, and answers under the frame's id", async () => {
    const c = setup(ok);
    expect(
      c.route({ namespaces: ["x"], from_ref: "B", nativeRef: "B" }),
    ).toBeUndefined();
    await vi.waitFor(() => expect(c.replies.length).toBe(1));
    expect(c.asked).toEqual([{ ref: "A", namespaces: ["x"] }]);
    expect(c.replies[0]).toEqual({
      v: 1,
      id: "7",
      type: "reach_proposed",
      confirm_url: CONFIRM,
      expires_at: EXP,
    });
  });

  it("an error result and a thrown one both come back as error frames", async () => {
    const a = setup(async () => ({
      ok: false,
      code: "no_role",
      message: REACH_COPY.no_role,
    }));
    a.route({ namespaces: ["x"] });
    await vi.waitFor(() => expect(a.replies.length).toBe(1));
    expect(a.replies[0]).toMatchObject({
      id: "7",
      type: "error",
      code: "no_role",
      message: REACH_COPY.no_role,
    });
    const b = setup(async () => {
      throw new Error(`boom ${TOKEN}`);
    });
    b.route({ namespaces: ["x"] });
    await vi.waitFor(() => expect(b.replies.length).toBe(1));
    expect(b.replies[0]).toMatchObject({
      type: "error",
      code: "hub_unavailable",
    });
    expect(JSON.stringify(b.replies)).not.toContain(TOKEN);
  });

  it("is refused for an adapter that did not list the cap, and asks nothing", () => {
    for (const caps of [undefined, ["mailbox", "pending", "follow"]]) {
      const c = setup(ok);
      expect(c.route({ namespaces: ["x"] }, hello(caps))).toMatchObject({
        type: "error",
        code: "bad_frame",
      });
      expect(c.asked).toEqual([]);
    }
  });
});

/** The daemon end to end: a real adapter connection, the stub hub, a fake fetch. */
describe("propose_reach through a running daemon", () => {
  const open = async (
    answer: (c: Call) => Response,
    caps = [ADAPTER_CAPS.reach],
  ) => {
    const f = fakeFetch(answer);
    const h = await daemonHarness({ fetch: f.fetch });
    const mine = await h.adapter("session-mine", { caps });
    await h.adapter("session-other", { caps });
    return { f, h, mine };
  };

  it("sends the calling session's ref, to the configured hub, with the machine token", async () => {
    const { f, mine } = await open((c) =>
      json(200, {
        confirmUrl: `${new URL(c.url).origin}/bus/reach/confirm#${SECRET}`,
        expiresAt: EXP,
      }),
    );
    expect(mine.welcome.caps).toContain(ADAPTER_CAPS.reach);
    const r = await mine.request({
      type: "propose_reach",
      namespaces: ["a"],
      // Not part of the frame: a caller cannot name another session.
      ...({ nativeRef: "session-other", from_ref: "session-other" } as object),
    } as never);
    expect(r.type).toBe("reach_proposed");
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0] as Call;
    expect(JSON.parse(String(call.init.body))).toEqual({
      nativeRef: "session-mine",
      namespaces: ["a"],
    });
    expect(call.url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/bus\/reach\/proposals$/,
    );
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("the other session's own call sends its own ref", async () => {
    const f = fakeFetch(() => conflict("no_role"));
    const h = await daemonHarness({ fetch: f.fetch });
    const other = await h.adapter("session-other", {
      caps: [ADAPTER_CAPS.reach],
    });
    const r = await other.request({ type: "propose_reach", namespaces: ["a"] });
    expect(r).toMatchObject({ type: "error", code: "no_role" });
    expect(JSON.parse(String(f.calls[0]?.init.body)).nativeRef).toBe(
      "session-other",
    );
  });

  it("a hub without the route (404) is a clear error, not a crash, and the daemon keeps serving", async () => {
    const { h, mine } = await open(() => new Response("nope", { status: 404 }));
    const r = await mine.request({ type: "propose_reach", namespaces: ["a"] });
    expect(r).toMatchObject({
      type: "error",
      code: "unsupported",
      message: REACH_COPY.old_hub,
    });
    expect(h.daemon.hub.open).toBe(true);
    expect((await mine.request({ type: "self" })).type).toBe("agent");
  });

  it("an adapter that did not list the cap is refused and nothing is posted", async () => {
    const { f, mine } = await open(() => json(200, {}), []);
    expect(mine.welcome.caps).toBeUndefined();
    const r = await mine.request({ type: "propose_reach", namespaces: ["a"] });
    expect(r).toMatchObject({ type: "error", code: "bad_frame" });
    expect(f.calls).toEqual([]);
  });

  it("an invalid frame (0 or 11 namespaces) never reaches the hub", async () => {
    const { f, mine } = await open(() => json(200, {}));
    for (const namespaces of [
      [],
      Array.from({ length: 11 }, (_, i) => `n${i}`),
    ]) {
      const r = await mine.request({ type: "propose_reach", namespaces });
      expect(r).toMatchObject({ type: "error", code: "bad_frame" });
    }
    expect(f.calls).toEqual([]);
  });
});
