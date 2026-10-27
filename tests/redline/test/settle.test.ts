import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundFetch,
  InfraError,
  setupFetch,
  setupTimeout,
} from "../src/fetch-timeout.ts";
import { call } from "../src/fixtures.ts";
import {
  crossWrite,
  NotRefused,
  type Side,
  snapshotDiff,
} from "../src/refused.ts";
import { settle, type Throwaway } from "../src/surfaces.ts";
import type { Target } from "../src/targets.ts";

// Settling a throwaway before its snapshot, the snapshot-diff message, and
// setup publishes timing out as infra (run 4: textIndexed flipped between the
// snapshots; slow setup publishes surfaced as red-line failures).

afterEach(() => {
  vi.unstubAllGlobals();
});

const target = { name: "rl-b", app: "http://rl-b.invalid" } as Target;
const side = {
  t: target,
  pat: { kind: "pat", token: "t" },
} as unknown as Side;
const art: Throwaway = {
  fresh: "artifact-personal",
  artifactId: "a".repeat(20),
};

/** A fetch stub: PUT thumbnail 204; GET versions answers from `indexed()`. */
function versionsFetch(indexed: () => boolean[]) {
  const seen: string[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    seen.push(`${req.method} ${path}`);
    if (req.method === "PUT" && path.endsWith("/thumbnail"))
      return new Response(null, { status: 204 });
    if (req.method === "GET" && path.endsWith("/versions"))
      return Response.json(
        indexed().map((textIndexed, i) => ({ version: i + 1, textIndexed })),
      );
    return new Response("{}", { status: 404 });
  });
  return { f, seen };
}

describe("settle", () => {
  it("seeds a thumbnail, then polls /versions until every entry is textIndexed", async () => {
    const states = [[false], [false], [true]];
    let n = 0;
    const { f, seen } = versionsFetch(
      () => states[Math.min(n++, states.length - 1)] as boolean[],
    );
    vi.stubGlobal("fetch", f);
    await settle(side, art, { ms: 5_000, pollMs: 1 });
    const A = `/api/v1/artifacts/${art.artifactId}`;
    expect(seen).toEqual([
      `PUT ${A}/thumbnail`,
      `GET ${A}/versions`,
      `GET ${A}/versions`,
      `GET ${A}/versions`,
    ]);
  });

  it("waits for every entry, not just the first", async () => {
    let n = 0;
    const { f } = versionsFetch(() => (n++ < 1 ? [true, false] : [true, true]));
    vi.stubGlobal("fetch", f);
    await settle(side, art, { ms: 5_000, pollMs: 1 });
    expect(n).toBe(2);
  });

  it("a wait that never settles is an infra error, bounded by ms", async () => {
    const { f } = versionsFetch(() => [false]);
    vi.stubGlobal("fetch", f);
    const t0 = Date.now();
    const p = settle(side, art, { ms: 50, pollMs: 5 });
    await expect(p).rejects.toThrow(InfraError);
    await expect(p).rejects.toThrow(
      /^infra: rl-b: the throwaway's versions were not text-indexed within 0s$/,
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("a space throwaway has nothing to settle (no request)", async () => {
    const { f } = versionsFetch(() => [false]);
    vi.stubGlobal("fetch", f);
    await settle(side, { fresh: "space" }, { ms: 50, pollMs: 5 });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("snapshot diff (key names only)", () => {
  const A = `/api/v1/artifacts/${"x".repeat(20)}`;
  const snap = (o: { art: object; data: object; versions: object[] }) =>
    [
      `${A} ${JSON.stringify(o.art)}`,
      `${A}/data/c ${JSON.stringify(o.data)}`,
      `${A}/shares ${JSON.stringify([])}`,
      `${A}/versions ${JSON.stringify(o.versions)}`,
    ].join("\n");
  const before = snap({
    art: { title: "SECRET-TITLE-1", thumbnailVersion: null, id: "same" },
    data: { items: [{ id: "d", v: "SECRET-DATA-1" }] },
    versions: [{ version: 1, textIndexed: false, message: "SECRET-MSG" }],
  });
  const after = snap({
    art: { title: "SECRET-TITLE-2", thumbnailVersion: 1, id: "same" },
    data: { items: [{ id: "d", v: "SECRET-DATA-2" }] },
    versions: [
      { version: 1, textIndexed: true, message: "SECRET-MSG" },
      { version: 2, textIndexed: false, message: "SECRET-NEW" },
    ],
  });

  it("names each differing path, its top-level keys and /versions per-entry keys", () => {
    expect(snapshotDiff(before, after)).toBe(
      "; differs: /api/v1/artifacts/:id keys thumbnailVersion, title; " +
        "/api/v1/artifacts/:id/data/c keys items; " +
        "/api/v1/artifacts/:id/versions keys [0].textIndexed, [1] added",
    );
    expect(snapshotDiff(before, before)).toBe("");
  });

  it("crossWrite's NotRefused carries the digests and key names, never a value", async () => {
    const t = (name: string) =>
      ({
        name,
        app: `http://${name}.invalid`,
        content: `http://${name}-content.invalid`,
      }) as Target;
    const a = t("rl-a");
    const b = t("rl-b");
    // crossWrite sends through http.ts send (the global fetch): all 401.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    let snaps = 0;
    const settled: string[] = [];
    const err = await crossWrite(
      async (_cred, _host, _x, f) => {
        // Reaches B with A's credential (the carries check) and is refused.
        await f(new Request(`${b.app}/x`, { headers: { authorization: "A" } }));
        return _cred === "A" && _host === b ? "deny" : "allow";
      },
      {
        a,
        b,
        credA: "A",
        credB: "B",
        carries: (r, c) => r.headers.get("authorization") === c,
        fresh: async () => "x",
        settle: async (host) => {
          settled.push(host.name);
        },
        snapshot: async () => (snaps++ === 0 ? before : after),
        dispose: async () => {},
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotRefused);
    const msg = (err as Error).message;
    expect(settled).toEqual(["rl-b"]);
    expect(msg).toMatch(
      /^rl-b: the throwaway changed \(sha256:[0-9a-f]{16} -> sha256:[0-9a-f]{16}\); differs: /,
    );
    expect(msg).toContain("/versions keys [0].textIndexed, [1] added");
    expect(msg).not.toMatch(/SECRET|x{20}/);
  });
});

describe("setup publish timeout", () => {
  /** A fetch that answers only when its signal aborts, with the abort reason. */
  const stalled: typeof fetch = (input, init) =>
    new Promise((_resolve, reject) => {
      const s =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      s?.addEventListener("abort", () => reject(s.reason), { once: true });
    });
  const req = () =>
    new Request("http://rl-b.invalid/api/v1/artifacts", { method: "POST" });

  it("the message names the phase, the bound and the install", () => {
    expect(new InfraError(setupTimeout("rl-b", 60_000)).message).toBe(
      "infra: setup publish timed out after 60s on rl-b",
    );
  });

  it("a stalled publish is an InfraError with that message", async () => {
    const p = setupFetch("rl-b", req(), { ms: 1_000, fetch: stalled });
    await expect(p).rejects.toThrow(InfraError);
    await expect(p).rejects.toThrow(
      /^infra: setup publish timed out after 1s on rl-b$/,
    );
  });

  it("is bounded by its own limit, not the suite's shorter per-fetch one", async () => {
    let calls = 0;
    const slowOk: typeof fetch = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 60));
      return new Response('{"id":"x"}', { status: 201 });
    };
    const { res, text } = await setupFetch("rl-b", req(), {
      ms: 5_000,
      fetch: boundFetch(slowOk, 10),
    });
    expect([res.status, text, calls]).toEqual([201, '{"id":"x"}', 1]);
  });

  it("a caller's own abort is not reported as infra", async () => {
    const c = new AbortController();
    const r = new Request("http://rl-b.invalid/", { signal: c.signal });
    const p = setupFetch("rl-b", r, { ms: 5_000, fetch: stalled });
    c.abort(new Error("caller abort"));
    await expect(p).rejects.toThrow("caller abort");
  });

  it("call() with setupOn uses it (a stalled publish is infra, never retried)", async () => {
    const f = vi.fn(stalled);
    vi.stubGlobal("fetch", boundFetch(f, 10));
    // SETUP_PUBLISH_MS would take a minute: prove the 10 ms bound is bypassed
    // and the call is made once, then abort it as the caller.
    const c = new AbortController();
    const p = call(
      new Request("http://rl-b.invalid/api/v1/artifacts", {
        method: "POST",
        signal: c.signal,
      }),
      "rl-b create throwaway",
      { setupOn: "rl-b" },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(f).toHaveBeenCalledTimes(1);
    c.abort(new Error("caller abort"));
    await expect(p).rejects.toThrow("caller abort");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
