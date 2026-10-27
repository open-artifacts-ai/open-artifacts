import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as tcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exitReason,
  reservePort,
  waitBroker,
  waitHealthy,
} from "../src/local-pair.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
});
/** A loopback HTTP server answering every request with `respond`. */
async function serve(
  respond: (url: URL) => {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<string> {
  const s = createServer((req, res) => {
    const r = respond(new URL(req.url ?? "/", "http://x"));
    res.writeHead(r.status, r.headers);
    res.end(r.body ?? "");
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const a = s.address();
  return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}
const bind = (port: number) =>
  new Promise<string>((res) => {
    const s = tcp();
    s.once("error", (e: NodeJS.ErrnoException) => res(e.code ?? "error"));
    s.listen(port, "127.0.0.1", () => s.close(() => res("ok")));
  });

describe("reservePort", () => {
  it("holds the port until released, then frees it (release is idempotent)", async () => {
    const r = await reservePort();
    expect(r.port).toBeGreaterThan(0);
    expect(await bind(r.port)).toBe("EADDRINUSE");
    await r.release();
    await r.release();
    expect(await bind(r.port)).toBe("ok");
  });
});

describe("exitReason", () => {
  const log = join(mkdtempSync(join(tmpdir(), "lp-")), "wrangler.log");
  it("is undefined while running; names the code, the log, and a taken port", () => {
    expect(exitReason("rl-a", undefined, log)).toBeUndefined();
    writeFileSync(
      log,
      "starting\nError: listen EADDRINUSE: address already in use 127.0.0.1:8787\n",
    );
    expect(exitReason("rl-a", 1, log)).toBe(
      `rl-a: wrangler dev exited early (code 1) (its port was taken: EADDRINUSE); see ${log}`,
    );
    writeFileSync(log, "some other failure\n");
    expect(exitReason("rl-a", null, log)).toBe(
      `rl-a: wrangler dev exited early (code null); see ${log}`,
    );
  });
});

describe("waitHealthy", () => {
  const me = { name: "rl-a", installId: "rl-a-local-abc123" };
  it("returns once the install answers as itself", async () => {
    const app = await serve(() => ({
      status: 200,
      body: JSON.stringify({ testHooks: true, installId: me.installId }),
    }));
    await waitHealthy({ ...me, app }, Date.now() + 5_000);
  });
  it("refuses a responder that is another install", async () => {
    const app = await serve(() => ({
      status: 200,
      body: JSON.stringify({ testHooks: true, installId: "someone-else" }),
    }));
    await expect(
      waitHealthy({ ...me, app }, Date.now() + 5_000),
    ).rejects.toThrow("/healthz: testHooks or installId wrong");
  });
  it("fails at once when its wrangler already exited, not at the deadline", async () => {
    const t0 = Date.now();
    await expect(
      waitHealthy(
        { ...me, app: "http://127.0.0.1:9" },
        Date.now() + 60_000,
        undefined,
        () => "rl-a: wrangler dev exited early",
      ),
    ).rejects.toThrow("exited early");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("waitBroker", () => {
  const probe = { installId: "rl-a-local-abc123", clientId: "fake-client" };
  it("returns once a well-formed authorize for our install redirects with our client id", async () => {
    let asked: URL | undefined;
    const url = await serve((u) => {
      asked = u;
      return {
        status: 302,
        headers: {
          location: `https://idp.example/authorize?client_id=${probe.clientId}`,
        },
      };
    });
    await waitBroker({ url }, probe, Date.now() + 5_000);
    expect(asked?.pathname).toBe("/google/authorize");
    expect(asked?.searchParams.get("install")).toBe(probe.installId);
    expect(asked?.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });
  it("refuses another process answering on the port", async () => {
    const url = await serve(() => ({
      status: 302,
      headers: {
        location: "https://elsewhere.example/authorize?client_id=other",
      },
    }));
    await expect(
      waitBroker({ url }, probe, Date.now() + 5_000),
    ).rejects.toThrow("answers as something else");
  });
  it("keeps waiting through a plain 404 (not yet ours), then times out", async () => {
    const url = await serve(() => ({
      status: 404,
      body: '{"error":"not_found"}',
    }));
    await expect(
      waitBroker({ url }, probe, Date.now() + 1_200),
    ).rejects.toThrow("did not come up in time");
  });
  it("fails at once when its wrangler already exited", async () => {
    const t0 = Date.now();
    await expect(
      waitBroker(
        { url: "http://127.0.0.1:9" },
        probe,
        Date.now() + 60_000,
        undefined,
        () => "broker: wrangler dev exited early",
      ),
    ).rejects.toThrow("exited early");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
