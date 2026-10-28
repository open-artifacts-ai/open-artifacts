import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { contentApp } from "../src/content/app.js";
import { cancelUnreadBody } from "../src/http/unread-body.js";
import { api, login } from "./helpers.js";

// An early refusal (401/404/400 before the handler reads the body) cancels
// the unread request stream instead of leaving it for workerd to complain
// about ("Can't read from request stream after response has been sent"),
// and never reads it.

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** A body that counts the chunks pulled and records a cancel. */
function tracked(chunks = 1000) {
  const s = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (s.pulled >= chunks) return c.close();
      s.pulled++;
      c.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      s.cancelled = true;
    },
  });
  return { s, body };
}

const post = (url: string, body: ReadableStream, headers = {}) =>
  new Request(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
    duplex: "half",
  } as RequestInit);

describe("unread request bodies on early refusals", () => {
  it("app 401 (no session): the body is cancelled, never read", async () => {
    const { s, body } = tracked();
    const r = await createApp().fetch(
      post("http://app.localhost/api/v1/artifacts", body, {
        "x-oa-request": "1",
      }),
      env,
      ctx,
    );
    expect(r.status).toBe(401);
    await r.body?.cancel();
    expect(s.cancelled).toBe(true);
    // At most the stream's own read-ahead, never the 64 MB.
    expect(s.pulled).toBeLessThan(4);
  });

  it("app 404 (unlisted route): cancelled", async () => {
    const { s, body } = tracked();
    const r = await createApp().fetch(
      post("http://app.localhost/api/v1/nope", body),
      env,
      ctx,
    );
    expect(r.status).toBe(404);
    expect(s.cancelled).toBe(true);
  });

  it("content host refusal: cancelled", async () => {
    const { s, body } = tracked();
    const r = await contentApp.fetch(
      post("http://content.localhost/c/x", body),
      env,
      ctx,
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(s.cancelled).toBe(true);
  });

  it("a body the handler read is left alone (a successful publish)", async () => {
    const u = await login(`unread-${crypto.randomUUID().slice(0, 8)}@x.com`);
    const r = await api(createApp(), "/api/v1/artifacts", u.cookie, {
      method: "POST",
      body: { title: "t", format: "html", content: "<p>x</p>" },
    });
    expect(r.status).toBe(201);
  });

  it("a handler that read the body, then refused: the middleware is a no-op", async () => {
    const { Hono } = await import("hono");
    const { cancelUnreadOnRefusal } = await import(
      "../src/http/unread-body.js"
    );
    const app = new Hono();
    app.use(cancelUnreadOnRefusal());
    let read = "";
    app.post("/x", async (c) => {
      read = await c.req.text();
      return c.json({ error: "bad" }, 400);
    });
    const { s, body } = tracked(2);
    const r = await app.fetch(post("http://app.localhost/x", body));
    expect(r.status).toBe(400);
    expect(read.length).toBe(2 * 64 * 1024);
    expect(s.cancelled).toBe(false);
  });

  it("cancelUnreadBody: no body, a used body or a locked one is a no-op", async () => {
    expect(cancelUnreadBody(new Request("http://x/"))).toBe(false);
    const used = new Request("http://x/", { method: "POST", body: "a" });
    await used.text();
    expect(cancelUnreadBody(used)).toBe(false);
    const locked = new Request("http://x/", { method: "POST", body: "a" });
    locked.body?.getReader();
    expect(cancelUnreadBody(locked)).toBe(false);
  });
});
