import { afterEach, describe, expect, it, vi } from "vitest";
import { authConfig } from "../src/auth/config.js";
import { requireTurnstile, verifyTurnstile } from "../src/auth/turnstile.js";
import { direct, trial } from "./auth-helpers.js";

const HOST = "app.example.com";
const ok = { success: true, hostname: HOST, action: "code_request" };

const siteverify = (reply: () => Response | Promise<Response>) => {
  const calls: URLSearchParams[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    expect(req.url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    calls.push(new URLSearchParams(await req.text()));
    return reply();
  });
  return calls;
};
afterEach(() => vi.restoreAllMocks());

describe("verifyTurnstile", () => {
  it("passes the secret, token and IP; true on success with our hostname and action", async () => {
    const calls = siteverify(() => Response.json(ok));
    expect(
      await verifyTurnstile(
        authConfig(trial()),
        "tok",
        "203.0.113.1",
        HOST,
        trial(),
      ),
    ).toBe(true);
    expect(Object.fromEntries(calls[0] ?? [])).toEqual({
      secret: "s",
      response: "tok",
      remoteip: "203.0.113.1",
    });
  });

  it("refuses a token solved for another hostname", async () => {
    siteverify(() => Response.json({ ...ok, hostname: "evil.example.com" }));
    expect(
      await verifyTurnstile(authConfig(trial()), "tok", null, HOST, trial()),
    ).toBe(false);
  });

  it("refuses a token solved for another action (or none)", async () => {
    siteverify(() => Response.json({ ...ok, action: "login" }));
    expect(
      await verifyTurnstile(authConfig(trial()), "tok", null, HOST, trial()),
    ).toBe(false);
    vi.restoreAllMocks();
    siteverify(() => Response.json({ success: true, hostname: HOST }));
    expect(
      await verifyTurnstile(authConfig(trial()), "tok", null, HOST, trial()),
    ).toBe(false);
  });

  it("fails closed: refusal, HTTP error, network error, no token, not configured", async () => {
    const cfg = authConfig(trial());
    siteverify(() => Response.json({ ...ok, success: false }));
    expect(await verifyTurnstile(cfg, "tok", null, HOST, trial())).toBe(false);
    vi.restoreAllMocks();
    siteverify(() => new Response("x", { status: 500 }));
    expect(await verifyTurnstile(cfg, "tok", null, HOST, trial())).toBe(false);
    vi.restoreAllMocks();
    siteverify(() => {
      throw new Error("down");
    });
    expect(await verifyTurnstile(cfg, "tok", null, HOST, trial())).toBe(false);
    expect(await verifyTurnstile(cfg, undefined, null, HOST, trial())).toBe(
      false,
    );
    expect(
      await verifyTurnstile(authConfig(direct()), "tok", null, HOST, trial()),
    ).toBe(false);
  });
});

describe("requireTurnstile", () => {
  it("when configured, every request needs a token: none is turnstile_required", async () => {
    const calls = siteverify(() => Response.json(ok));
    for (let i = 0; i < 3; i++) {
      await expect(
        requireTurnstile(authConfig(trial()), undefined, null, HOST, trial()),
      ).rejects.toMatchObject({
        code: "turnstile_required",
        details: { field: "turnstile", required: true },
      });
      await requireTurnstile(
        authConfig(trial()),
        `tok${i}`,
        null,
        HOST,
        trial(),
      );
    }
    expect(calls).toHaveLength(3);
  });

  it("a refused token is turnstile_failed", async () => {
    siteverify(() => Response.json({ ...ok, action: "other" }));
    await expect(
      requireTurnstile(authConfig(trial()), "tok", null, HOST, trial()),
    ).rejects.toMatchObject({ code: "turnstile_failed" });
  });

  it("not configured: no check", async () => {
    const calls = siteverify(() => Response.json(ok));
    await requireTurnstile(
      authConfig(direct()),
      undefined,
      null,
      HOST,
      trial(),
    );
    expect(calls).toHaveLength(0);
  });
});
