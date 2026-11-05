// Agent identity cards on hot paths. Runs serially via vitest.cpu.config.ts
// (median of 7). Absolute times are reports (budget(): asserted only under
// test:cpu:strict); the gates are size independence and the per-isolate
// memo: a burst of MCP requests on one grant makes no D1 call after the first.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  redirectInfo,
  resetTouchMemo,
  touchGrant,
  uaFamily,
} from "../src/services/agent-usage.js";
import { budget, medianMs as time } from "./cpu-time.js";
import { login } from "./helpers.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("consent: User-Agent and redirect parsing (global 10 ms budget)", () => {
  it("a 64 KB User-Agent costs what a normal one does (prefix only)", async ({
    annotate,
  }) => {
    const huge = `${"Mozilla/5.0 (".repeat(5000)}${"a".repeat(1000)}`;
    expect(huge.length).toBeGreaterThan(64_000);
    const loop = (ua: string) => async () => {
      for (let i = 0; i < 1000; i++) uaFamily(ua);
    };
    const normal = await time(loop(UA));
    const big = await time(loop(huge));
    await budget(annotate, "1000 x uaFamily (normal)", normal, 10);
    await budget(annotate, "1000 x uaFamily (64 KB)", big, 10);
    // The huge input is sliced to 512 chars before any regex.
    expect(big).toBeLessThan(normal * 4 + 5);
  });

  it("1000 redirect classifications stay well under a request budget", async ({
    annotate,
  }) => {
    const ms = await time(async () => {
      for (let i = 0; i < 1000; i++) {
        redirectInfo("http://127.0.0.1:3333/cb");
        redirectInfo("https://claude.ai/api/mcp/auth_callback");
      }
    });
    await budget(annotate, "2000 x redirectInfo", ms, 10);
  });
});

describe("MCP hot path: grant use", () => {
  it("a burst on one grant makes one D1 call, then none within the minute", async ({
    annotate,
  }) => {
    const u = await login("cpu-touch@example.com");
    let calls = 0;
    const DB = new Proxy(env.DB, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (k === "prepare")
          return (q: string) => {
            calls++;
            return t.prepare(q);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const e = { ...(env as Env), DB } as Env;
    resetTouchMemo();
    const t0 = Date.now();
    await touchGrant(e, "cpu-grant", u.userId, "1.0", t0);
    expect(calls).toBe(1);
    let i = 0;
    const ms = await time(async () => {
      for (let j = 0; j < 100; j++)
        await touchGrant(e, "cpu-grant", u.userId, "1.0", t0 + ++i);
    });
    expect(calls).toBe(1);
    await budget(annotate, "100 memo-skipped touches", ms, 1);
  });
});
