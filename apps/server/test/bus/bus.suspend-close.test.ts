// #202 (cloud): the platform's suspend calls the install Worker's scheduled
// handler with cron `oa:close-sockets`; a live bus daemon socket must close
// 4403 promptly. End to end: the daemon connects through the real Worker
// route /bus/connect on a hosted install with the bus feature on, the cron
// runs exactly as suspend.sockets.test.ts drives it, the socket closes.
import { BUS_ROUTES } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { CLOSE_SOCKETS_CRON, scheduled } from "../../src/cron.js";
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
