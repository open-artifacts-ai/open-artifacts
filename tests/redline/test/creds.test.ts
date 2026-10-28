import { describe, expect, it, vi } from "vitest";
import {
  authorizeCode,
  authorizeRefused,
  KV_CACHE_TTL_MS,
  KV_SETTLE_SLACK_MS,
  oauthStoreMode,
  once,
  slot,
  slotValue,
  tokenRefused,
  untilKvSettled,
} from "../src/creds.ts";
import { NotRefused, registerMarker } from "../src/refused.ts";
import type { Target } from "../src/targets.ts";

const B = {
  name: "rl-b",
  app: "https://rl-b.example.app",
  content: "https://rl-b.example.page",
} as Target;

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("tokenRefused", () => {
  const r = tokenRefused(["invalid_grant"]);
  it("accepts a 400 invalid_grant with no token", async () => {
    await expect(
      r(json(400, { error: "invalid_grant" }), B),
    ).resolves.toBeUndefined();
  });
  it("rejects a 200", async () => {
    await expect(r(json(200, { access_token: "x" }), B)).rejects.toThrow(
      NotRefused,
    );
  });
  it("rejects an error response that carries a token", async () => {
    await expect(
      r(json(400, { error: "invalid_grant", access_token: "x" }), B),
    ).rejects.toThrow(/a token was issued/);
  });
  it("rejects an error outside the allowed set", async () => {
    await expect(r(json(401, { error: "invalid_client" }), B)).rejects.toThrow(
      /error is not/,
    );
  });
  it("rejects a 403 (only 400 or 401)", async () => {
    await expect(r(json(403, { error: "invalid_grant" }), B)).rejects.toThrow(
      NotRefused,
    );
  });
  it("rejects a non-JSON body", async () => {
    await expect(r(new Response("nope", { status: 400 }), B)).rejects.toThrow(
      /not an OAuth error/,
    );
  });
});

describe("authorizeRefused", () => {
  it("accepts a 400 page", async () => {
    await expect(
      authorizeRefused(new Response("bad client", { status: 400 }), B),
    ).resolves.toBeUndefined();
  });
  it("rejects a redirect carrying a code", async () => {
    const res = new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/cb?code=abc&state=s" },
    });
    await expect(authorizeRefused(res, B)).rejects.toThrow(/with a code/);
  });
  it("rejects a 200", async () => {
    await expect(
      authorizeRefused(new Response("<p>hi</p>", { status: 200 }), B),
    ).rejects.toThrow(NotRefused);
  });
  const consentPage =
    '<form><input type="hidden" name="csrf" value="1.x">' +
    '<input type="hidden" name="request" value="h"></form>';
  it("rejects a consent page (B resolved A's client)", async () => {
    await expect(
      authorizeRefused(new Response(consentPage, { status: 200 }), B),
    ).rejects.toThrow(NotRefused);
  });
  it("rejects a 400 that still carries a consent form", async () => {
    await expect(
      authorizeRefused(new Response(consentPage, { status: 400 }), B),
    ).rejects.toThrow(/consent form/);
  });
  it("rejects a body holding a seeded marker", async () => {
    registerMarker(B, "REDLINE-rl-b-authz");
    await expect(
      authorizeRefused(
        new Response("x REDLINE-rl-b-authz", { status: 400 }),
        B,
      ),
    ).rejects.toThrow(/marker/);
  });
});

describe("slots", () => {
  it("resolve per host, and once() hands out each value once", () => {
    const A = { ...B, name: "rl-a" } as Target;
    const c = slot((t) => t.name);
    expect(slotValue(c, A)).toBe("rl-a");
    expect(slotValue(c, B)).toBe("rl-b");
    const next = once(1, 2);
    expect([next(), next()]).toEqual([1, 2]);
    expect(next).toThrow(/already used/);
  });
});

describe("untilKvSettled (#769)", () => {
  it("the window is derived from KV's 60 s cache TTL plus slack", () => {
    expect(KV_CACHE_TTL_MS).toBe(60_000);
    expect(KV_SETTLE_SLACK_MS).toBeGreaterThan(0);
  });

  it("waits until TTL + slack past the timestamp, on a deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const since = Date.now();
      let done = false;
      const p = untilKvSettled(since).then((d) => {
        done = true;
        return d;
      });
      await vi.advanceTimersByTimeAsync(KV_CACHE_TTL_MS);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(KV_SETTLE_SLACK_MS);
      expect(await p).toBe(since + KV_CACHE_TTL_MS + KV_SETTLE_SLACK_MS);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns at once when the deadline has passed", async () => {
    const t0 = Date.now();
    await untilKvSettled(t0 - KV_CACHE_TTL_MS - KV_SETTLE_SLACK_MS - 1);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe("authorizeCode", () => {
  const cookie = { kind: "cookie", name: "oa_session", value: "v" } as const;
  const pkce = { verifier: "v", challenge: "c" };
  const form = () =>
    new Response(
      '<input name="csrf" value="x"><input name="request" value="r">',
      { status: 200 },
    );
  const approved = () =>
    new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/p5-redline-callback?code=fresh" },
    });
  const reset = () =>
    Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });

  it("re-runs the whole flow once after no response, minting a fresh code", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (calls.length === 2) throw reset();
      return (init?.method ?? "GET") === "POST" ? approved() : form();
    });
    vi.stubGlobal("fetch", f);
    try {
      await expect(
        authorizeCode(B, cookie as never, "client", pkce as never, "res"),
      ).resolves.toBe("fresh");
      // GET, POST (reset), then a fresh GET and POST: never a resent code.
      expect(calls).toEqual(["GET", "POST", "GET", "POST"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a second no-response is infra, never a fail or a pass", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw reset();
      }),
    );
    try {
      await expect(
        authorizeCode(B, cookie as never, "client", pkce as never, "res"),
      ).rejects.toThrow(
        /^infra: setup OAuth code flow got no response on rl-b/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an HTTP refusal is not retried", async () => {
    const f = vi.fn(async () => new Response("no", { status: 403 }));
    vi.stubGlobal("fetch", f);
    try {
      await expect(
        authorizeCode(B, cookie as never, "client", pkce as never, "res"),
      ).rejects.not.toThrow(/^infra/);
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("oauthStoreMode", () => {
  const healthz = (body: unknown, status = 200) =>
    vi.fn(async () => json(status, body));
  it("reads /healthz oauthStore.mode; absent or unknown is kv", async () => {
    for (const [body, want] of [
      [{ ok: true, oauthStore: { mode: "d1" } }, "d1"],
      [{ ok: true, oauthStore: { mode: "dual" } }, "dual"],
      [{ ok: true, oauthStore: { mode: "kv" } }, "kv"],
      [{ ok: true }, "kv"],
      [{ ok: true, oauthStore: { mode: "D1" } }, "kv"],
    ] as const) {
      vi.stubGlobal("fetch", healthz(body));
      try {
        await expect(oauthStoreMode(B)).resolves.toBe(want);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
  it("a non-200 /healthz throws", async () => {
    vi.stubGlobal(
      "fetch",
      healthz({ error: "oauth_store_misconfigured" }, 503),
    );
    try {
      await expect(oauthStoreMode(B)).rejects.toThrow(/healthz/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
