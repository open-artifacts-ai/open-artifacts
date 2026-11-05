import { afterEach, describe, expect, it, vi } from "vitest";
import { authConfig } from "../src/auth/config.js";
import type { Env } from "../src/env.js";
import { trial } from "./auth-helpers.js";

// Red-line installs (rl-a, rl-b) run Cloudflare's always-pass Turnstile TEST
// secret; siteverify then answers { success, hostname: "example.com",
// metadata: { result_with_testing_key: true } } with no action (captured from
// the live API, 2026-10-27). That answer is accepted only on a test build with
// live hooks AND exactly the test secret; anything else keeps the strict check.
const HOST = "app.example.com";
const TEST_SECRET = "1x0000000000000000000000000000000AA";
const testAnswer = {
  challenge_ts: "2026-10-27T01:41:07.205Z",
  "error-codes": [],
  hostname: "example.com",
  metadata: { result_with_testing_key: true },
  success: true,
};
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
  it("accepts the test-key answer with live hooks and exactly the test secret", async () => {
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
    [
      "secret lowercase",
      { ...live, TURNSTILE_SECRET: "1x0000000000000000000000000000000aa" },
      true,
    ],
    ["secret padded", { ...live, TURNSTILE_SECRET: ` ${TEST_SECRET}` }, true],
  ];
  for (const [what, over, allowed] of missing)
    it(`${what}: the test-key answer is turnstile_failed`, async () => {
      await expect(check(over, testAnswer, allowed)).rejects.toMatchObject({
        code: "turnstile_failed",
      });
    });

  it("a real secret: the test-key answer is refused even with hooks live", async () => {
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
      { ...testAnswer, metadata: undefined },
      { ...testAnswer, metadata: {} },
      { ...testAnswer, metadata: { result_with_testing_key: false } },
      { ...testAnswer, metadata: { result_with_testing_key: "true" } },
      { ...testAnswer, metadata: "result_with_testing_key" },
      { success: true, hostname: "localhost", action: "test" },
    ])
      await expect(check(live, a)).rejects.toMatchObject({
        code: "turnstile_failed",
      });
  });

  it("a real secret: an answer carrying result_with_testing_key is still judged strictly", async () => {
    const real = { ...live, TURNSTILE_SECRET: "0x4AAAAAAA-real-secret" };
    const marker = { metadata: { result_with_testing_key: true } };
    for (const a of [
      { ...marker, success: true, hostname: HOST, action: "test" },
      {
        ...marker,
        success: true,
        hostname: "example.com",
        action: "code_request",
      },
      { ...marker, success: true, hostname: "example.com" },
    ])
      await expect(check(real, a)).rejects.toMatchObject({
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
