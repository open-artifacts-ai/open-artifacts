// #1567 project links over REST: GET R.busLinks lists the member's links,
// PUT links two namespaces (idempotent), DELETE R.busLink(id) removes one.
// Only the member, in a browser session: a PAT, an OAuth grant or a machine
// token never links, so no AI agent can widen what a namespace reaches.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BUS_LINK_MAX, type BusLink, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { BusHub } from "../../src/bus/hub.js";
import { api, errOf, fetchAndWait } from "../helpers.js";
import { daemon, e, hubOf, machine, member, ns } from "./helpers.js";

const app = createApp();

/** A member whose machine has connected (so a hub exists for it). */
async function withBus() {
  const who = await member();
  const m = await machine("MacBook", who.userId);
  const d = await daemon(m.token);
  d.send({
    v: 1,
    id: "h",
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
  });
  await d.next();
  return { who, d, m };
}

const putLink = (auth: string | null, body: unknown) =>
  api(app, R.busLinks, auth, { method: "PUT", body });

describe("links REST (#1567)", () => {
  it("the member links, lists, relinks idempotently and unlinks", async () => {
    const [a, b] = [ns("la"), ns("lb")];
    const { who, d } = await withBus();
    const set = await putLink(who.cookie, { a: b, b: a });
    expect(set.status).toBe(200);
    const { link } = (await set.json()) as { link: BusLink };
    expect(link).toMatchObject({ a: a < b ? a : b, b: a < b ? b : a });
    expect(Object.keys(link).sort()).toEqual(["a", "b", "createdAt", "id"]);
    // The same pair, either way round, is the same link.
    const again = await putLink(who.cookie, { a, b });
    expect(((await again.json()) as { link: BusLink }).link).toEqual(link);
    expect(await (await api(app, R.busLinks, who.cookie)).json()).toEqual({
      links: [link],
      live: true,
    });
    expect(
      (await api(app, R.busLink(link.id), who.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(
      (await api(app, R.busLink(link.id), who.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(await (await api(app, R.busLinks, who.cookie)).json()).toEqual({
      links: [],
      live: true,
    });
    d.close();
  });

  it("400 for an invalid body, equal or non-canonical namespaces", async () => {
    const a = ns("la");
    const { who, d } = await withBus();
    for (const body of [
      { a },
      { a, b: a },
      { a, b: ns("x"), extra: 1 },
      { a, b: "Not Canonical" },
      { a: 7, b: a },
    ]) {
      const r = await putLink(who.cookie, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await (await hubOf(who.userId)).listLinks()).toEqual([]);
    d.close();
  });

  it("409 link_limit at the cap; DELETE takes an id of at most 64 id characters", async () => {
    const { who, d } = await withBus();
    const hub = await hubOf(who.userId);
    await runInDurableObject(hub, (i) => BusHub.setMaxLinksForTests(i, 1));
    expect((await putLink(who.cookie, { a: ns("p"), b: ns("q") })).status).toBe(
      200,
    );
    const over = await putLink(who.cookie, { a: ns("r"), b: ns("s") });
    expect(over.status).toBe(409);
    expect((await errOf(over)).details).toEqual({ reason: "link_limit" });
    expect(BUS_LINK_MAX).toBe(100);
    for (const bad of ["a".repeat(65), "a%20b", "a.b"]) {
      const r = await api(app, `${R.busLinks}/${bad}`, who.cookie, {
        method: "DELETE",
      });
      expect(r.status, bad).toBe(400);
    }
    d.close();
  });

  it("another member reaches only their own hub", async () => {
    const [a, b] = [ns("la"), ns("lb")];
    const one = await withBus();
    const two = await withBus();
    await putLink(one.who.cookie, { a, b });
    expect(await (await api(app, R.busLinks, two.who.cookie)).json()).toEqual({
      links: [],
      live: true,
    });
    const [mine] = await (await hubOf(one.who.userId)).listLinks();
    expect(
      (
        await api(app, R.busLink(mine?.id ?? ""), two.who.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(await (await hubOf(one.who.userId)).listLinks()).toHaveLength(1);
    one.d.close();
    two.d.close();
  });

  it("a PAT may read but never link or unlink; a machine token, guests, capped and anonymous callers get nothing", async () => {
    const [a, b] = [ns("la"), ns("lb")];
    const { who, d, m } = await withBus();
    const { link } = (await (await putLink(who.cookie, { a, b })).json()) as {
      link: BusLink;
    };
    const { token } = await createPat(e, who.userId, "agent");
    expect((await api(app, R.busLinks, token)).status).toBe(200);
    expect((await putLink(token, { a, b: ns("c") })).status).toBe(404);
    expect(
      (await api(app, R.busLink(link.id), token, { method: "DELETE" })).status,
    ).toBe(404);
    // A cookie session that also carries an Authorization header is not a
    // person in a browser either.
    const mixed = await api(app, R.busLinks, who.cookie, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: { a, b: ns("c") },
    });
    expect([401, 404]).toContain(mixed.status);

    const guest = await member("guest");
    const capped = await member();
    await e.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(capped.userId)
      .run();
    for (const c of [guest.cookie, capped.cookie]) {
      expect((await api(app, R.busLinks, c)).status).toBe(404);
      expect((await putLink(c, { a, b: ns("c") })).status).toBe(404);
      expect(
        (await api(app, R.busLink(link.id), c, { method: "DELETE" })).status,
      ).toBe(404);
    }
    expect((await api(app, R.busLinks, null)).status).toBe(401);
    expect((await putLink(null, { a, b: ns("c") })).status).toBe(401);
    expect(
      (await api(app, R.busLink(link.id), null, { method: "DELETE" })).status,
    ).toBe(401);
    // The machine token is bus-only.
    const r = await api(app, R.busLinks, null, {
      method: "PUT",
      headers: { authorization: `Bearer ${m.token}` },
      body: { a, b: ns("c") },
    });
    expect(r.status).toBe(401);
    expect(await (await hubOf(who.userId)).listLinks()).toEqual([link]);
    d.close();
  });

  it("a member with no machine that connected never reaches a BusHub", async () => {
    const dave = await member();
    await machine("never", dave.userId);
    const ev = {
      ...env,
      BUS_HUB: {
        idFromName: () => {
          throw new Error("reached the BusHub");
        },
        get: () => {
          throw new Error("reached the BusHub");
        },
      },
    };
    const call = (path: string, method = "GET", body?: unknown) =>
      fetchAndWait(
        app,
        new Request(`http://app.localhost${path}`, {
          method,
          headers: {
            cookie: dave.cookie,
            "x-oa-request": "1",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        ev,
      );
    const list = await call(R.busLinks);
    expect(await list.json()).toEqual({ links: [], live: false });
    const put = await call(R.busLinks, "PUT", { a: "x/y", b: "x/z" });
    expect(put.status).toBe(409);
    expect((await call(R.busLink("nope"), "DELETE")).status).toBe(204);
  });
});
