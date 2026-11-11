// B13 adversarial review: each test was a break on 7e2e7ef (fixed in fix round 1).
import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, doAsPaid, login, PAID_ENV } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let viewer: U;
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}
const pub = async (extra: Record<string, unknown> = {}) =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "t",
        format: "html",
        content: "<p>x</p>",
        capabilities: { db: true, viewer: true, storage: true },
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
const anon = (path: string, ip: string, e: object, init: RequestInit = {}) =>
  app.fetch(
    new Request(`http://app.localhost${path}`, {
      ...init,
      headers: {
        "cf-connecting-ip": ip,
        "content-type": "application/json",
        ...(init.headers as Record<string, string>),
      },
    }),
    { ...env, ...e } as never,
    ctx,
  );

beforeAll(async () => {
  owner = await mk("b13-owner");
  viewer = await mk("b13-viewer");
});

describe("B13 breaks", () => {
  it("IPv6: one /64 must share one RL_ANON_WRITES key (rotating ::1, ::2 bypasses the ceiling)", async () => {
    const id = await pub({ visibility: "public", allowAnonymousWrites: true });
    const keys: string[] = [];
    const rl = {
      limit: async (o: { key: string }) => {
        keys.push(o.key);
        return { success: true };
      },
    };
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2::2"])
      await anon(
        R.dataDoc(id, "c", "a"),
        ip,
        { RL_ANON_WRITES: rl },
        { method: "PUT", body: "1" },
      );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("RL_ANON unbound in production must fail closed, not allow unlimited anon writes", async () => {
    const id = await pub({ visibility: "public", allowAnonymousWrites: true });
    const r = await anon(
      R.dataDoc(id, "c", "a"),
      "203.0.113.9",
      {
        RL_ANON: undefined,
        RL_ANON_WRITES: undefined,
        ENVIRONMENT: "production",
      },
      { method: "PUT", body: "1" },
    );
    expect(r.status).not.toBe(200);
  });

  it("revoked share: an open subscribe socket keeps streaming data", async () => {
    const id = await pub({ visibility: "private" });
    expect(
      (
        await api(app, R.shares(id), owner.cookie, {
          method: "PUT",
          body: { email: viewer.email, role: "viewer" },
        })
      ).status,
    ).toBeLessThan(300);
    const r = await api(app, R.dataSubscribe(id, "c"), viewer.cookie, {
      headers: { upgrade: "websocket" },
    });
    const ws = r.webSocket;
    if (!ws) throw new Error("no ws");
    ws.accept();
    const msgs: string[] = [];
    ws.addEventListener("message", (e) => msgs.push(String(e.data)));
    await api(app, R.share(id, viewer.email), owner.cookie, {
      method: "DELETE",
    });
    await api(app, R.dataDoc(id, "c", "secret"), owner.cookie, {
      method: "PUT",
      body: { s: 1 },
    });
    await new Promise((res) => setTimeout(res, 100));
    expect(msgs).toEqual([]);
  });

  it("one anonymous IP can take all 200 sockets of a public artifact (DoS)", async () => {
    const id = await pub({ visibility: "public" });
    const open: WebSocket[] = [];
    // Stops at the first refusal (the per-actor cap) instead of making all 200
    // upgrades: 200 sequential upgrades could pass the 5 s default on slow runs.
    let refused = false;
    for (let i = 0; i < 200 && !refused; i++) {
      const r = await anon(
        R.dataSubscribe(id, "c"),
        "203.0.113.50",
        {},
        { headers: { upgrade: "websocket" } },
      );
      if (r.webSocket) {
        r.webSocket.accept();
        open.push(r.webSocket);
      } else refused = r.status === 429;
    }
    expect(refused).toBe(true);
    expect(open.length).toBeLessThan(200);
    const v = await api(app, R.dataSubscribe(id, "c"), viewer.cookie, {
      headers: { upgrade: "websocket" },
    });
    for (const w of open) w.close();
    expect(v.status).toBe(101);
  }, 30_000);
});

describe("B13 CPU", () => {
  it("PUT of a ~1 MB doc: forwarded raw via setRaw; the Worker never JSON.parses it", async () => {
    const id = await pub({ visibility: "team" });
    await doAsPaid(runtimeStub(env, id)); // ~1 MB docs: the Paid limit
    const body: Record<string, number> = {};
    for (let i = 0; i < 90_000; i++) body[`k${i}`] = 0; // ~980 KB JSON
    const text = JSON.stringify(body);
    // Wrap the runtime namespace (env injection): record setRaw args and the
    // JSON.parse calls made before the RPC (i.e. in the Worker route path).
    const real = env.ARTIFACT_RUNTIME;
    const parse = vi.spyOn(JSON, "parse");
    const forwarded: unknown[][] = [];
    let parsedBeforeRpc: unknown[][] | null = null;
    const ns = {
      idFromName: (n: string) => real.idFromName(n),
      get(oid: DurableObjectId) {
        const stub = real.get(oid) as unknown as Record<string, unknown>;
        return new Proxy(stub, {
          get(t, k) {
            if (k !== "setRaw") return Reflect.get(t, k);
            return (...args: unknown[]) => {
              parsedBeforeRpc ??= [...parse.mock.calls];
              forwarded.push(args);
              return (t.setRaw as (...a: unknown[]) => unknown)(...args);
            };
          },
        });
      },
    };
    try {
      const r = await app.fetch(
        new Request(`http://app.localhost${R.dataDoc(id, "c", "big")}`, {
          method: "PUT",
          headers: {
            cookie: viewer.cookie,
            "x-oa-request": "1",
            "content-type": "application/json",
          },
          body: text,
        }),
        { ...env, PLAN: "paid", ARTIFACT_RUNTIME: ns } as never,
        ctx,
      );
      expect(r.status).toBe(200);
      const out = await r.text();
      expect(forwarded).toHaveLength(1);
      const [col, doc, raw, actor] = forwarded[0] as unknown[];
      expect([col, doc, actor]).toEqual(["c", "big", `u:${viewer.userId}`]);
      // The body travels as its raw UTF-8 bytes, byte-for-byte.
      expect(raw).toBeInstanceOf(ArrayBuffer);
      expect(new TextDecoder().decode(raw as ArrayBuffer)).toBe(text);
      // No JSON.parse of anything body-sized: not before the RPC, not at all.
      const big = (calls: unknown[][]) =>
        calls.filter((c) => typeof c[0] === "string" && c[0].length > 10_000);
      expect(parsedBeforeRpc).not.toBeNull();
      expect(big(parsedBeforeRpc ?? [])).toEqual([]);
      expect(big(parse.mock.calls)).toEqual([]);
      // The response echoes the stored doc, spliced from the original bytes.
      expect(out.length).toBeGreaterThan(text.length);
      expect(out).toContain(`"data":${text}`);
    } finally {
      parse.mockRestore();
    }
  });
});

describe("B13 deep JSON", () => {
  it("a 500k-deep array doc is a 400, not a 500 from the RPC clone stack overflow", async () => {
    const id = await pub({ visibility: "team" });
    await doAsPaid(runtimeStub(env, id)); // ~1 MB docs: the Paid limit
    const r = await app.fetch(
      new Request(`http://app.localhost${R.dataDoc(id, "c", "deep")}`, {
        method: "PUT",
        headers: {
          cookie: viewer.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body: "[".repeat(500_000) + "]".repeat(500_000),
      }),
      PAID_ENV,
      ctx,
    );
    expect(r.status).toBe(400);
  });
});
