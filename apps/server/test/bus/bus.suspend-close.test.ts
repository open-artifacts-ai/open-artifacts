// #202 (cloud): the platform's suspend calls the install Worker's scheduled
// handler with cron `oa:close-sockets`; a live bus daemon socket must close
// 4403 promptly. End to end: the daemon connects through the real Worker
// route /bus/connect on a hosted install with the bus feature on, the cron
// runs exactly as suspend.sockets.test.ts drives it, the socket closes.
import { BUS_ROUTES } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { CLOSE_SOCKETS_CRON, RESUME_CRON, scheduled } from "../../src/cron.js";
import type { Env } from "../../src/env.js";
import { busOn } from "../../src/services/bus.js";
import { H as HOSTED_H } from "../billing-helpers.js";
import { fetchAndWait } from "../helpers.js";
import { daemon, hello, machine, member, up, waitFor } from "./helpers.js";

/** A hosted install with the bus feature on. */
const H = {
  ...HOSTED_H,
  FEATURES: `${HOSTED_H.FEATURES},bus`,
} as typeof HOSTED_H;
const app = createApp();

describe("suspend's close-sockets job closes a live daemon socket (#202)", () => {
  it("a hosted install: the daemon's socket closes 4403 promptly", async () => {
    expect(H.HOSTED).toBe("1");
    expect(busOn(H as unknown as Env)).toBe(true);
    const u = await member();
    const m = await machine("suspend-box", u.userId);
    const d = await daemon(m.token, {}, (token) =>
      fetchAndWait(
        app,
        new Request(`http://app.localhost${BUS_ROUTES.connect}`, {
          headers: {
            Upgrade: "websocket",
            authorization: `Bearer ${token}`,
            "cf-connecting-ip": "198.51.100.7",
          },
        }),
        H,
      ),
    );
    d.send(hello());
    await waitFor(d, "hello_ok");
    d.send(up("s1", "ref-1", "sleeper", "test.local/suspend"));
    await waitFor(d, "agent_ok");

    const t0 = Date.now();
    await scheduled(
      { cron: CLOSE_SOCKETS_CRON },
      H as unknown as Env,
      {
        waitUntil: () => {},
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext,
    );
    const c = await Promise.race([
      d.closed,
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    expect(c, "socket still open 10 s after the job").not.toBeNull();
    expect(c?.code).toBe(4403);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

// Cloud #228: the install refuses bus connects from its own D1 the moment the
// suspend job runs, until the resume job clears the marker.
describe("a suspended install refuses bus connects at once (cloud #228)", () => {
  const ctx = {
    waitUntil: () => {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const job = (cron: string, e: object = H) =>
    scheduled({ cron }, e as unknown as Env, ctx);
  let ip = 0;
  const nextIp = () => {
    ip = (ip % 200) + 10;
    return ip;
  };
  // Opened sockets are closed at once so the file's settle check passes.
  const status = async (r: Response) => {
    if (r.status === 101 && r.webSocket) {
      r.webSocket.accept();
      r.webSocket.close(1000, "done");
    }
    return r.status;
  };
  const connect = (token: string, e: object = H) =>
    app.fetch(
      new Request(`http://app.localhost${BUS_ROUTES.connect}`, {
        headers: {
          Upgrade: "websocket",
          authorization: `Bearer ${token}`,
          "cf-connecting-ip": `198.51.100.${nextIp()}`,
        },
      }),
      e as never,
      ctx,
    );

  it("refuses with the paused 503 after suspend, accepts again after resume", async () => {
    const u = await member();
    const m = await machine("resume-box", u.userId);
    await job(RESUME_CRON); // harmless without a prior suspend
    expect(await status(await connect(m.token))).toBe(101);

    await job(CLOSE_SOCKETS_CRON);
    await job(CLOSE_SOCKETS_CRON); // idempotent
    const r = await connect(m.token);
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain("This workspace is paused");
    // Other routes are unaffected.
    expect(
      (
        await app.fetch(
          new Request("http://app.localhost/healthz"),
          H as never,
          ctx,
        )
      ).status,
    ).not.toBe(503);

    await job(RESUME_CRON);
    await job(RESUME_CRON);
    // A fresh user: the hub's own post-closeAll cooldown (429) is not the
    // marker's business.
    const u2 = await member();
    const m2 = await machine("resume-box-2", u2.userId);
    expect(await status(await connect(m2.token))).toBe(101);
  });

  it("a self-host install (not HOSTED) never reads the marker", async () => {
    const u = await member();
    const m = await machine("selfhost-box", u.userId);
    await job(CLOSE_SOCKETS_CRON);
    const self = { ...H, HOSTED: "0" };
    expect(await status(await connect(m.token, self))).toBe(101);
    await job(RESUME_CRON);
  });

  it("an unknown oa: job is still refused", async () => {
    await expect(job("oa:nope")).rejects.toThrow("unknown system job");
    expect(RESUME_CRON).toBe("oa:resume");
  });
});
