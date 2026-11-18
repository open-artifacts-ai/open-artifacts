// #2653: an owner or admin takes an address off the "Don't email me again"
// list. This install's list only; never the address in the audit row.
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { addressHash } from "../src/email/share-optout.js";
import type { Env } from "../src/env.js";
import { uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

const remove = (cookie: string | null, body: unknown) =>
  app.fetch(
    new Request(`http://app.localhost${R.outsideShareOptouts}`, {
      method: "DELETE",
      headers: {
        ...(cookie ? { cookie } : {}),
        "x-oa-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env as Env,
    ctx,
  );
const optOut = async (email: string) =>
  env.DB.prepare(
    "insert into email_optouts (address_hash, created_at) values (?, ?)",
  )
    .bind(await addressHash(email), Date.now())
    .run();
const listed = async (email: string) =>
  (await env.DB.prepare("select 1 from email_optouts where address_hash = ?")
    .bind(await addressHash(email))
    .first()) !== null;
const auditRows = async (hash: string) =>
  (
    await env.DB.prepare(
      "select actor_id, action, detail from audit_events where action = 'settings.change' and instr(detail, ?) > 0",
    )
      .bind(hash)
      .all<{ actor_id: string; action: string; detail: string }>()
  ).results;

describe("removing an opt-out (#2653)", () => {
  it("an owner or admin removes it by address, whatever the case or spaces; the audit row has the hash and never the address", async () => {
    for (const role of ["owner", "admin"] as const) {
      const a = await login(uniq(role, "a.com"), role);
      const to = uniq("gone", "gmail.com");
      await optOut(to);
      const r = await remove(a.cookie, { email: ` ${to.toUpperCase()} ` });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ removed: true });
      expect(await listed(to)).toBe(false);
      const hash = (await addressHash(to)) as string;
      const rows = await auditRows(hash);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_id).toBe(a.userId);
      expect(rows[0]?.detail).not.toContain(to);
      expect(JSON.parse(rows[0]?.detail ?? "{}")).toMatchObject({
        removedOptout: hash,
      });
    }
  });

  it("an address that isn't listed: removed false, nothing audited; another address's row stays", async () => {
    const a = await login(uniq("own", "a.com"), "owner");
    const other = uniq("keep", "gmail.com");
    await optOut(other);
    const none = uniq("none", "gmail.com");
    const r = await remove(a.cookie, { email: none });
    expect(await r.json()).toEqual({ removed: false });
    expect(await auditRows((await addressHash(none)) as string)).toHaveLength(
      0,
    );
    expect(await listed(other)).toBe(true);
  });

  it("a member, a guest and anonymous are refused, and the row stays", async () => {
    const to = uniq("stay", "gmail.com");
    await optOut(to);
    const m = await login(uniq("mem", "a.com"), "member");
    const g = await login(uniq("gst", "a.com"), "guest");
    expect((await remove(m.cookie, { email: to })).status).toBe(404);
    expect((await remove(g.cookie, { email: to })).status).toBe(404);
    expect((await remove(null, { email: to })).status).toBe(401);
    expect(await listed(to)).toBe(true);
    expect(await auditRows((await addressHash(to)) as string)).toHaveLength(0);
  });

  it("a body that isn't an address is a 400", async () => {
    const a = await login(uniq("own", "a.com"), "owner");
    expect((await remove(a.cookie, {})).status).toBe(400);
    expect((await remove(a.cookie, { email: "not an address" })).status).toBe(
      400,
    );
  });
});
