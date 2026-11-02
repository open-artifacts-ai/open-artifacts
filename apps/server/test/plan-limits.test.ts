// Plan-aware limits (env PLAN): data docs 256 KB on Free / 1 MB on Paid on
// every write path, and the generic /mcp body cap checked before any parse.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  dataDocTooLargeMessage,
  LIMITS,
  type Member,
  mcpTooLargeMessage,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { VERSION } from "../src/version.gen.js";
import { errOf, fetchAndWait, login } from "./helpers.js";
import { callWorker, connect, E, MCP_URL } from "./mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const FREE = { ...(env as Env), PLAN: undefined } as Env;
const PAID = { ...(env as Env), PLAN: "paid" } as Env;
/** Paid with DATA_DOC_BYTES = 1536 KB: the /mcp cap becomes 1600 KB. */
const PAID_BIG = { ...PAID, DATA_DOC_BYTES: String(1536 * 1024) } as Env;
/** Free with DATA_DOC_BYTES = 64 KB. */
const FREE_SMALL = { ...FREE, DATA_DOC_BYTES: String(64 * 1024) } as Env;
let owner: { cookie: string; member: Member };
let pat: string;

beforeAll(async () => {
  const l = await login(`plan-${tag}@x.com`);
  const m = await getUser(env as Env, l.userId);
  if (!m) throw new Error("no user");
  owner = { cookie: l.cookie, member: m };
  pat = (await createPat(env as Env, l.userId, "plan-agent")).token;
});

/** An artifact whose DO runs with `e` (the DO reads PLAN from its own env). */
async function art(e: Env): Promise<string> {
  const id = (
    await publish(
      env as Env,
      owner.member,
      {
        title: "data",
        format: "html",
        content: "<p>x</p>",
        capabilities: { db: true, viewer: true, storage: true },
      } as never,
      null,
    )
  ).id;
  await runInDurableObject(
    runtimeStub(e, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (i) => {
      (i as unknown as { env: Env }).env = e;
    },
  );
  return id;
}

/** A doc whose minified JSON is about `bytes` (escape-light text). */
const doc = (bytes: number) => JSON.stringify({ text: "x".repeat(bytes - 11) });

/** A request whose body stream counts reads; `length` sets Content-Length. */
function send(
  method: string,
  url: string,
  body: string,
  e: Env,
  headers: Record<string, string>,
  length = true,
) {
  const bytes = new TextEncoder().encode(body);
  const state = { read: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (state.read >= bytes.length) return c.close();
        const n = Math.min(16 * 1024, bytes.length - state.read);
        c.enqueue(bytes.slice(state.read, state.read + n));
        state.read += n;
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request(url, {
    method,
    headers: {
      ...headers,
      ...(length ? { "content-length": String(bytes.length) } : {}),
    },
    body: stream,
    duplex: "half",
  } as RequestInit);
  const res = url.startsWith(MCP_URL)
    ? callWorker(req, e)
    : fetchAndWait(app, req, e);
  return { res, state, size: bytes.length };
}
const rest = (
  method: string,
  path: string,
  body: string,
  e: Env,
  length = true,
) =>
  send(
    method,
    `http://app.localhost${path}`,
    body,
    e,
    {
      cookie: owner.cookie,
      "x-oa-request": "1",
      "content-type": "application/json",
    },
    length,
  );
const mcp = (
  args: Record<string, unknown>,
  name: string,
  e: Env,
  length = true,
) =>
  send(
    "POST",
    MCP_URL,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    e,
    {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${pat}`,
    },
    length,
  );
/** The JSON-RPC message of an MCP answer (JSON or one SSE event). */
const rpcOf = async (r: Response) => {
  const t = await r.text();
  return JSON.parse(/^data: (.*)$/m.exec(t)?.[1] ?? t) as {
    id: unknown;
    result?: { isError?: boolean; content: { text: string }[] };
    error?: { code: number; message: string };
  };
};
const FREE_MSG = dataDocTooLargeMessage("free");

describe("data docs: 256 KB on Free, 1 MB on Paid", () => {
  it("REST PUT over the Free limit → 413 with the plan message", async () => {
    const id = await art(FREE);
    const r = await rest("PUT", R.dataDoc(id, "c", "a"), doc(300 * 1024), FREE)
      .res;
    expect(r.status).toBe(413);
    expect(await errOf(r)).toMatchObject({
      code: "too_large",
      message: FREE_MSG,
    });
    const ok = await rest("PUT", R.dataDoc(id, "c", "a"), doc(250 * 1024), FREE)
      .res;
    expect(ok.status).toBe(200);
  });

  it("REST: a body over the Free doc cap is refused before it is read", async () => {
    const id = await art(FREE);
    const { res, state } = rest(
      "PUT",
      R.dataDoc(id, "c", "a"),
      doc(LIMITS.dataDocBytesFree + 128 * 1024),
      FREE,
    );
    const r = await res;
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(FREE_MSG);
    expect(state.read).toBe(0);
  });

  it("REST PATCH and storage PUT over the Free limit → 413", async () => {
    const id = await art(FREE);
    const big = doc(300 * 1024);
    const p = await rest("PATCH", R.dataDoc(id, "c", "b"), big, FREE).res;
    expect(p.status).toBe(413);
    expect((await errOf(p)).message).toBe(FREE_MSG);
    const s = await rest(
      "PUT",
      R.storageKey(id, "k"),
      JSON.stringify({ value: "x".repeat(300 * 1024) }),
      FREE,
    ).res;
    expect(s.status).toBe(413);
    expect((await errOf(s)).message).toBe(FREE_MSG);
  });

  it("REST counts the body as sent: a pretty-printed doc over the limit is 413", async () => {
    const id = await art(FREE);
    const data = {
      rows: Array.from({ length: 9000 }, (_, i) => ({ i, v: "x".repeat(8) })),
    };
    const minified = JSON.stringify(data);
    const pretty = JSON.stringify(data, null, 2);
    expect(minified.length).toBeLessThan(LIMITS.dataDocBytesFree);
    expect(pretty.length).toBeGreaterThan(LIMITS.dataDocBytesFree);
    const r = await rest("PUT", R.dataDoc(id, "c", "p"), pretty, FREE).res;
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(FREE_MSG);
    const ok = await rest("PUT", R.dataDoc(id, "c", "p"), minified, FREE).res;
    expect(ok.status).toBe(200);
  });

  it("the exact boundary: a body of the limit is accepted, one byte more is 413", async () => {
    const id = await art(FREE);
    const at = JSON.stringify("x".repeat(LIMITS.dataDocBytesFree - 2));
    expect(at.length).toBe(LIMITS.dataDocBytesFree);
    expect(
      (await rest("PUT", R.dataDoc(id, "c", "b"), at, FREE).res).status,
    ).toBe(200);
    const over = JSON.stringify("x".repeat(LIMITS.dataDocBytesFree - 1));
    const { res, state } = rest("PUT", R.dataDoc(id, "c", "b"), over, FREE);
    const r = await res;
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(FREE_MSG);
    expect(state.read).toBe(0);
  });

  it("a merge that overflows (two 200 KB patches) is 413", async () => {
    const id = await art(FREE);
    const patch = (k: string) =>
      JSON.stringify({ [k]: "x".repeat(200 * 1024) });
    expect(
      (await rest("PATCH", R.dataDoc(id, "c", "m"), patch("a"), FREE).res)
        .status,
    ).toBe(200);
    const r = await rest("PATCH", R.dataDoc(id, "c", "m"), patch("b"), FREE)
      .res;
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(FREE_MSG);
  });

  it("UTF-8 bytes count: 70 K emoji (280 KB) is 413 on set, setRaw and storageSet", async () => {
    const id = await art(FREE);
    const emoji = "😀".repeat(70 * 1024);
    expect(JSON.stringify(emoji).length).toBeLessThan(LIMITS.dataDocBytesFree);
    const s = runtimeStub(FREE, id);
    const outcome = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => String((e as Error)?.message ?? e),
      );
    expect(await outcome(s.set("c", "e", emoji, "u:1"))).toContain(FREE_MSG);
    expect(
      await outcome(s.setRaw("c", "e", JSON.stringify(emoji), "u:1")),
    ).toContain(FREE_MSG);
    expect(await outcome(s.storageSet("u:1", "k", emoji))).toContain(FREE_MSG);
  });

  it("a legacy 600 KB doc on Free: readable, a shrinking PATCH works, one that stays over is 413", async () => {
    const id = await art(PAID);
    const big = JSON.stringify({ keep: "y", big: "x".repeat(600 * 1024) });
    expect(
      (await rest("PUT", R.dataDoc(id, "c", "l"), big, PAID).res).status,
    ).toBe(200);
    // The instance moves to Free (its DO too).
    await runInDurableObject(
      runtimeStub(FREE, id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (i) => {
        (i as unknown as { env: Env }).env = FREE;
      },
    );
    const get = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.dataDoc(id, "c", "l")}`, {
        headers: { cookie: owner.cookie, "x-oa-request": "1" },
      }),
      FREE,
    );
    expect(get.status).toBe(200);
    const stays = await rest(
      "PATCH",
      R.dataDoc(id, "c", "l"),
      JSON.stringify({ keep: "z" }),
      FREE,
    ).res;
    expect(stays.status).toBe(413);
    expect((await errOf(stays)).message).toBe(FREE_MSG);
    const shrink = await rest(
      "PATCH",
      R.dataDoc(id, "c", "l"),
      JSON.stringify({ big: "small" }),
      FREE,
    ).res;
    expect(shrink.status).toBe(200);
  });

  it("Paid: a ~1 MB doc is accepted over REST", async () => {
    const id = await art(PAID);
    const r = await rest(
      "PUT",
      R.dataDoc(id, "c", "a"),
      doc(LIMITS.dataDocBytesPaid - 1024),
      PAID,
    ).res;
    expect(r.status).toBe(200);
  });

  it("MCP artifact_data_set / update over the Free limit → too_large with the plan message", async () => {
    const id = await art(FREE);
    const data = { text: "x".repeat(270 * 1024) };
    for (const [tool, args] of [
      ["artifact_data_set", { data }],
      ["artifact_data_update", { patch: data }],
    ] as const) {
      const r = await mcp(
        { id, collection: "c", docId: "a", ...args },
        tool,
        FREE,
      ).res;
      const m = await rpcOf(r);
      expect(m.result?.isError).toBe(true);
      expect(m.result?.content[0]?.text).toBe(`too_large: ${FREE_MSG}`);
    }
  });

  it("the runtime bridge path (the DO) enforces the plan's limit", async () => {
    const free = await art(FREE);
    const paid = await art(PAID);
    const big = "x".repeat(300 * 1024);
    /** The RPC's outcome, caught on the call itself (no stray rejection). */
    const outcome = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => String((e as Error)?.message ?? e),
      );
    const fs = runtimeStub(FREE, free);
    expect(await outcome(fs.set("c", "a", big, "u:1"))).toContain(FREE_MSG);
    expect(
      await outcome(fs.setRaw("c", "a", JSON.stringify(big), "u:1")),
    ).toContain(FREE_MSG);
    expect(await outcome(fs.update("c", "b", { big }, "u:1"))).toContain(
      FREE_MSG,
    );
    expect(
      await outcome(runtimeStub(PAID, paid).set("c", "a", big, "u:1")),
    ).toBe("ok");
  });
});

describe("/mcp body cap (before any parse)", () => {
  it("Free: a declared body over 320 KB → 413 JSON-RPC error, unread", async () => {
    const id = await art(FREE);
    const { res, state, size } = mcp(
      { id, collection: "c", docId: "a", data: { t: "x".repeat(330 * 1024) } },
      "artifact_data_set",
      FREE,
    );
    expect(size).toBeGreaterThan(LIMITS.mcpBodyBytesFree);
    const r = await res;
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: mcpTooLargeMessage("free") },
    });
    expect(state.read).toBe(0);
  });

  it("Free: with no Content-Length the read stops at the cap", async () => {
    const { res, state, size } = mcp(
      { title: "t", format: "html", content: "x".repeat(4 * 1024 * 1024) },
      "publish_artifact",
      FREE,
      false,
    );
    const r = await res;
    expect(r.status).toBe(413);
    expect((await rpcOf(r)).error?.message).toBe(mcpTooLargeMessage("free"));
    expect(state.read).toBeLessThanOrEqual(LIMITS.mcpBodyBytesFree + 16 * 1024);
    expect(state.read).toBeLessThan(size);
  });

  it("Paid: a 900 KB data doc over MCP is accepted", async () => {
    const id = await art(PAID);
    const r = await mcp(
      { id, collection: "c", docId: "a", data: { t: "x".repeat(900 * 1024) } },
      "artifact_data_set",
      PAID,
    ).res;
    const m = await rpcOf(r);
    expect(m.result?.isError).toBeUndefined();
  });

  it("Paid: over 1 MB + 64 KB → 413 with the Paid message", async () => {
    const r = await mcp(
      { title: "t", format: "html", content: "x".repeat(1200 * 1024) },
      "publish_artifact",
      PAID,
    ).res;
    expect(r.status).toBe(413);
    expect((await rpcOf(r)).error?.message).toBe(mcpTooLargeMessage("paid"));
  });
});

describe("DATA_DOC_BYTES override", () => {
  it("REST: the body cap and 413 message follow the effective limit", async () => {
    const id = await art(FREE_SMALL);
    const r = await rest(
      "PUT",
      R.dataDoc(id, "c", "a"),
      doc(100 * 1024),
      FREE_SMALL,
    ).res;
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(
      dataDocTooLargeMessage("free", 64 * 1024),
    );
    const ok = await rest(
      "PUT",
      R.dataDoc(id, "c", "a"),
      doc(60 * 1024),
      FREE_SMALL,
    ).res;
    expect(ok.status).toBe(200);
  });

  it("/mcp on Paid: a 1.2 MB doc fits a 1536 KB limit; over 1600 KB → 413 with the effective numbers", async () => {
    const id = await art(PAID_BIG);
    const r = await mcp(
      { id, collection: "c", docId: "a", data: { t: "x".repeat(1200 * 1024) } },
      "artifact_data_set",
      PAID_BIG,
    ).res;
    expect(r.status).toBe(200);
    expect((await rpcOf(r)).result?.isError).toBeUndefined();
    const big = await mcp(
      { title: "t", format: "html", content: "x".repeat(1700 * 1024) },
      "publish_artifact",
      PAID_BIG,
    ).res;
    expect(big.status).toBe(413);
    const m = (await rpcOf(big)).error?.message;
    expect(m).toBe(mcpTooLargeMessage("paid", 1536 * 1024));
    expect(m).toContain("Request body exceeds 1600 KB on this instance.");
    expect(m).toContain("limited to 1536 KB");
  });

  it("the MCP instructions state the effective per-doc limit", async () => {
    const c = await connect(pat, { env: PAID_BIG });
    expect(c.getInstructions()).toContain(
      "- Limits: 1536 KB per document on this instance (paid plan), 50 MB per artifact",
    );
    const d = await connect(pat, { env: PAID });
    expect(d.getInstructions()).toContain(
      "- Limits: 1 MB per document on this instance (paid plan), 50 MB per artifact",
    );
  });
});

describe("/healthz", () => {
  it("reports the plan, public and cheap", async () => {
    for (const [e, plan] of [
      [FREE, "free"],
      [E({ PLAN: "paid" }), "paid"],
      [E({ PLAN: " Paid\n" }), "paid"],
      [E({ PLAN: "pro" }), "free"],
    ] as const) {
      const r = await fetchAndWait(
        app,
        new Request("http://app.localhost/healthz"),
        e,
      );
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        ok: true,
        plan,
        version: VERSION,
        oauthStore: { mode: "kv", backfilled: false, kvWritesOffSince: null },
      });
    }
  });
});
