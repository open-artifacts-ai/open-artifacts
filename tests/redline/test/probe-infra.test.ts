import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfraError, isNetworkError } from "../src/fetch-timeout.ts";
import { sendProbe } from "../src/http.ts";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { crossProbe, crossWrite } from "../src/refused.ts";
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

  it("a body cut off after a status is a fail, never retried", async () => {
    // 200 with a partial body, then a reset; a retry would answer 403 and
    // read as a refusal.
    let n = 0;
    server = createServer((req, res) => {
      if (n++ === 0) {
        res.writeHead(200, { "content-length": "100" });
        res.write("partial", () => req.socket.destroy());
        return;
      }
      res.writeHead(403).end();
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const e = await sendProbe(
      new Request(`http://127.0.0.1:${port}/live`),
      wsHandshake,
    ).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(InfraError);
    expect(isNetworkError(e)).toBe(false);
    expect((e as Error).message).toBe("body failed after status 200");
    expect(n).toBe(1);
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

describe("a connection cut mid-body in a cross-install probe", () => {
  /** B's own credential at /rl-b, A's at /rl-a and /rl-b, through one server. */
  async function probe(cut: "B at B" | "A at B") {
    let cuts = 0;
    let denies = 0;
    server = createServer((req, res) => {
      const who = req.headers.authorization;
      const key = `${who} at ${req.url === "/rl-a" ? "A" : "B"}`;
      if (key === "A at B") denies++;
      if (key === cut && cuts === 0) {
        cuts++;
        res.writeHead(200, { "content-length": "100" });
        res.write("partial", () => req.socket.destroy());
        return;
      }
      if (key === "A at B") res.writeHead(403).end("{}");
      else res.writeHead(200).end("{}");
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const t = (name: string) =>
      ({
        name,
        app: `http://127.0.0.1:${port}`,
        content: `http://127.0.0.1:${port}`,
      }) as Target;
    const run = crossProbe<string>(
      async (cred, host, f) => {
        const r = await f(
          new Request(`${host.app}/${host.name}`, {
            headers: { authorization: cred },
          }),
        );
        await r.text();
        return r.status === 200 ? "allow" : "deny";
      },
      {
        a: t("rl-a"),
        b: t("rl-b"),
        credA: "A",
        credB: "B",
        carries: (r, c) => r.headers.get("authorization") === c,
      },
    );
    return { run, denies: () => denies };
  }

  it("on an allow leg is retried, and the probe goes on", async () => {
    const { run } = await probe("B at B");
    await expect(run).resolves.toBeUndefined();
  });

  it("on the deny leg is a fail, never retried into a refusal", async () => {
    const { run, denies } = await probe("A at B");
    await expect(run).rejects.toThrow(/A's credential at B/);
    expect(denies()).toBe(1);
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

  it("a later setup with no response still disposes what was made", async () => {
    const t = (name: string) =>
      ({ name, app: `http://${name}.invalid` }) as Target;
    const disposed: string[] = [];
    let n = 0;
    const e = await crossWrite(async () => "allow", {
      a: t("rl-a"),
      b: t("rl-b"),
      credA: "A",
      credB: "B",
      carries: () => true,
      fresh: async (h) => {
        if (n++ === 0) return h.name;
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
    expect(disposed).toEqual(["rl-b"]);
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
