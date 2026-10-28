import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfraError, isNetworkError } from "../src/fetch-timeout.ts";
import { sendProbe } from "../src/http.ts";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { crossWrite } from "../src/refused.ts";
import type { Target } from "../src/targets.ts";
import { rawRequest, wsHandshake } from "../src/ws.ts";

// Run 8 (0.73.0): a WebSocket refusal probe and a write probe's setup got no
// response during an rl-b reset burst and counted as fail. No response is
// tried once more (an idempotent probe), then infra; never a verdict.

let server: Server | undefined;
afterEach(async () => {
  setCurrentTest(() => undefined);
  takeFileNotes();
  vi.unstubAllGlobals();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A local server that resets the first `resets` connections, then answers `status`. */
async function resetting(resets: number, status: number): Promise<string> {
  let n = 0;
  server = createServer((req, res) => {
    if (n++ < resets) {
      req.socket.destroy();
      return;
    }
    res.writeHead(status).end();
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/live`;
}

describe("WebSocket probes with no response", () => {
  it("a reset keeps its code, so it reads as no response", async () => {
    const url = await resetting(1, 403);
    const e = await rawRequest({ url, headers: new Headers() }).catch(
      (x: unknown) => x,
    );
    expect(isNetworkError(e)).toBe(true);
    expect((e as Error).message).toBe("request failed (ECONNRESET)");
  });

  it("one reset: tried once more, and the answer is the verdict", async () => {
    const url = await resetting(1, 403);
    const r = await sendProbe(new Request(url), wsHandshake);
    expect(r.status).toBe(403);
  });

  it("two resets: infra, never a pass", async () => {
    const url = await resetting(2, 403);
    const e = await sendProbe(new Request(url), wsHandshake).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(InfraError);
    expect((e as Error).message).toMatch(
      /^infra: probe GET \/live on 127\.0\.0\.1:\d+ got no response twice \(ECONNRESET\)/,
    );
  });

  it("a timeout reads as no response too", async () => {
    server = createServer(() => {});
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const e = await rawRequest({
      url: `http://127.0.0.1:${port}/live`,
      headers: new Headers(),
      timeoutMs: 50,
    }).catch((x: unknown) => x);
    expect(isNetworkError(e)).toBe(true);
    server.closeAllConnections();
  });
});

describe("a write probe's setup with no response", () => {
  it("is infra, tagged with nothing that reads as a fail", async () => {
    const t = (name: string) =>
      ({ name, app: `http://${name}.invalid` }) as Target;
    const disposed: string[] = [];
    const e = await crossWrite(async () => "allow", {
      a: t("rl-a"),
      b: t("rl-b"),
      credA: "A",
      credB: "B",
      carries: () => true,
      fresh: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
      },
      snapshot: async () => "",
      dispose: async (h) => {
        disposed.push(h.name);
      },
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InfraError);
    expect((e as Error).message).toBe(
      "infra: setup on rl-b got no response (ECONNRESET)",
    );
  });

  it("any other setup error still fails", async () => {
    const t = (name: string) =>
      ({ name, app: `http://${name}.invalid` }) as Target;
    const e = await crossWrite(async () => "allow", {
      a: t("rl-a"),
      b: t("rl-b"),
      credA: "A",
      credB: "B",
      carries: () => true,
      fresh: async () => {
        throw new Error("setup said 400");
      },
      snapshot: async () => "",
      dispose: async () => {},
    }).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(InfraError);
    expect((e as Error).message).toContain("setup said 400");
  });
});
