import { afterEach, describe, expect, it, vi } from "vitest";
import { authConfig } from "../src/auth/config.js";
import type { Env } from "../src/env.js";
import { trial } from "./auth-helpers.js";

// Red-line installs (rl-a, rl-b) run Cloudflare's always-pass Turnstile TEST
// secret; siteverify then answers { success, hostname: "localhost", action:
// "test" }. That answer is accepted only on a test build with live hooks AND
// exactly the test secret; anything else keeps the strict check.
const HOST = "app.example.com";
const TEST_SECRET = "1x0000000000000000000000000000000AA";
const testAnswer = { success: true, hostname: "localhost", action: "test" };
const live: Partial<Env> = {
  TURNSTILE_SECRET: TEST_SECRET,
  TEST_HOOKS: "1",
  TEST_HOOK_KEY: "k".repeat(32),
  TEST_DOMAIN: "p5.test",
};

const siteverify = (answer: object) =>
  vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(answer));

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@oa/shared");
  vi.resetModules();
});

async function load(allowed = true) {
  vi.resetModules();
  vi.doMock("@oa/shared", async (orig) => ({
    ...(await orig<typeof import("@oa/shared")>()),
    TEST_HOOKS_ALLOWED: allowed,
  }));
  return import("../src/auth/turnstile.js");
}

async function check(over: Partial<Env>, answer: object, allowed = true) {
  const { requireTurnstile } = await load(allowed);
  const e = trial(over);
  siteverify(answer);
  return requireTurnstile(
    authConfig(e),
    "XXXX.DUMMY.TOKEN.XXXX",
    null,
    HOST,
    e,
  );
}

describe("Turnstile test key on a live-hook test install", () => {
  it("accepts { localhost, test } with live hooks and exactly the test secret", async () => {
    await expect(check(live, testAnswer)).resolves.toBeUndefined();
  });

  const missing: [string, Partial<Env>, boolean][] = [
    ["build flag off", live, false],
    ["TEST_HOOKS not 1", { ...live, TEST_HOOKS: "0" }, true],
    ["key under 32 chars", { ...live, TEST_HOOK_KEY: "k".repeat(31) }, true],
    ["no TEST_DOMAIN", { ...live, TEST_DOMAIN: "" }, true],
    [
      "secret one char off",
      { ...live, TURNSTILE_SECRET: "1x0000000000000000000000000000000AB" },
      true,
    ],
    ["secret padded", { ...live, TURNSTILE_SECRET: ` ${TEST_SECRET}` }, true],
  ];
  for (const [what, over, allowed] of missing)
    it(`${what}: { localhost, test } is turnstile_failed`, async () => {
      await expect(check(over, testAnswer, allowed)).rejects.toMatchObject({
        code: "turnstile_failed",
      });
    });

  it("a real secret: { localhost, test } is refused even with hooks live", async () => {
    await expect(
      check(
        { ...live, TURNSTILE_SECRET: "0x4AAAAAAA-real-secret" },
        testAnswer,
      ),
    ).rejects.toMatchObject({ code: "turnstile_failed" });
  });

  it("the test secret never widens anything else: a failed or partial test answer is refused", async () => {
    for (const a of [
      { ...testAnswer, success: false },
      { ...testAnswer, hostname: HOST },
      { ...testAnswer, action: "code_request" },
      { success: true, hostname: "localhost" },
    ])
      await expect(check(live, a)).rejects.toMatchObject({
        code: "turnstile_failed",
      });
  });

  it("strict path (regression): a real secret with our hostname and action passes, hooks live or not", async () => {
    const strict = { success: true, hostname: HOST, action: "code_request" };
    const real = { TURNSTILE_SECRET: "0x4AAAAAAA-real-secret" };
    await expect(check({ ...live, ...real }, strict)).resolves.toBeUndefined();
    await expect(check(real, strict, false)).resolves.toBeUndefined();
  });

  it("no token is still turnstile_required with the test secret and live hooks", async () => {
    const { requireTurnstile } = await load();
    const e = trial(live);
    const spy = siteverify(testAnswer);
    await expect(
      requireTurnstile(authConfig(e), undefined, null, HOST, e),
    ).rejects.toMatchObject({ code: "turnstile_required" });
    expect(spy).not.toHaveBeenCalled();
  });
});
