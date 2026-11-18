// #2820: with INSTALL_OPTOUT_KEY the opt-out table and tokens use a keyed hash;
// without it, and for every row and link from before, nothing changes.
import { env } from "cloudflare:workers";
import { R, ShareResultSchema } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { deriveKey } from "../src/auth/keys.js";
import {
  addressHash,
  keyedAddressHash,
  SHARE_OPTOUT_PATH,
  signOptoutToken,
  verifyOptoutToken,
} from "../src/email/share-optout.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { b64urlEncode, hmacSign } from "../src/util/crypto.js";
import { direct, mailer, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const APP = "http://app.localhost";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
afterEach(() => vi.restoreAllMocks());

const KEY_BYTES = crypto.getRandomValues(new Uint8Array(48));
const KEY = b64urlEncode(KEY_BYTES);
const WITH_KEY: Partial<Env> = { INSTALL_OPTOUT_KEY: KEY };

const post = (e: Env, path: string, form?: Record<string, string>) =>
  app.fetch(
    new Request(`${APP}${path}`, {
      method: "POST",
      ...(form
        ? {
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(form),
          }
        : {}),
    }),
    e,
    ctx,
  );
const optOut = (e: Env, t: string) =>
  post(e, `${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(t)}`);
const undo = (e: Env, t: string) =>
  post(e, SHARE_OPTOUT_PATH, { t, action: "undo" });
const rows = async (hash: string | null) =>
  hash
    ? ((
        await env.DB.prepare(
          "select count(*) n from email_optouts where address_hash = ?",
        )
          .bind(hash)
          .first<{ n: number }>()
      )?.n ?? 0)
    : 0;
const legacy = async (email: string) => rows(await addressHash(email));
const keyed = async (e: Env, email: string) =>
  rows(await keyedAddressHash(e, email));

/** A v1 token, as an email sent before the key carries. */
const v1Token = async (e: Env, email: string) => {
  const h = (await addressHash(email)) as string;
  return `v1.${h}.${await hmacSign(await deriveKey(e, "oa:share-optout"), `v1:share-email-off:${h}`)}`;
};

async function world(over: Partial<Env> = {}) {
  const m = mailer();
  const e = direct({ ...m.env, ...over }) as Env;
  const o = await login(uniq("own", "a.com"), "member");
  const member = await getUser(env, o.userId);
  if (!member) throw new Error("no user");
  const share = async (email: string) => {
    const { id } = await publish(
      env,
      member,
      { title: "Plan", format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    );
    const r = await fetchAndWait(
      app,
      new Request(`${APP}${R.shares(id)}`, {
        method: "PUT",
        headers: {
          cookie: o.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, role: "viewer" }),
      }),
      e,
    );
    expect(r.status).toBe(200);
    return ShareResultSchema.parse(await r.json());
  };
  return { m, e, share };
}
const suppressedShare = (r: { emailed: boolean; notEmailed?: string }) =>
  r.emailed === false && r.notEmailed === "skipped";

describe("no key: today's behaviour, exactly", () => {
  it("a v1 token, a plain SHA-256 row, no keyed hash", async () => {
    const { e, share, m } = await world();
    const to = uniq("nk", "gmail.com");
    expect(await keyedAddressHash(e, to)).toBeNull();
    const first = await share(to);
    expect(first.emailed).toBe(true);
    const t = await signOptoutToken(e, uniq("tk", "gmail.com"));
    expect(t.startsWith("v1.")).toBe(true);
    const mailTo = m.sent.find((x) => x.to === to);
    const link = /https:\/\/[^"\s<]*unsubscribe\/shares\?t=([^"&\s<]+)/.exec(
      String(mailTo?.html),
    );
    expect(decodeURIComponent(link?.[1] ?? "").startsWith("v1.")).toBe(true);
    await optOut(e, decodeURIComponent(link?.[1] ?? ""));
    expect(await legacy(to)).toBe(1);
    expect(suppressedShare(await share(to))).toBe(true);
  });

  it("a key that can't be decoded or is too short counts as not set", async () => {
    for (const bad of [
      "",
      "   ",
      "short",
      "!!!not-base64!!!",
      b64urlEncode(new Uint8Array(8)),
    ]) {
      const e = direct({ INSTALL_OPTOUT_KEY: bad }) as Env;
      expect(await keyedAddressHash(e, "a@gmail.com")).toBeNull();
      expect((await signOptoutToken(e, "a@gmail.com")).startsWith("v1.")).toBe(
        true,
      );
    }
  });
});

describe("with the key", () => {
  it("new tokens are v2, the row is `k1:` + the HMAC under the raw key bytes, never the SHA-256", async () => {
    const { e, share, m } = await world(WITH_KEY);
    const to = uniq("kk", "gmail.com");
    await share(to);
    const html = String(m.sent.find((x) => x.to === to)?.html);
    const t = decodeURIComponent(
      /unsubscribe\/shares\?t=([^"&\s<]+)/.exec(html)?.[1] ?? "",
    );
    expect(t.startsWith("v2.")).toBe(true);
    // An independent HMAC of the normalized address under the key bytes.
    const k = await crypto.subtle.importKey(
      "raw",
      KEY_BYTES,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(to)),
    );
    const expected = `k1:${b64urlEncode(mac)}`;
    expect(await keyedAddressHash(e, to)).toBe(expected);
    expect(await verifyOptoutToken(e, t)).toBe(expected);
    await optOut(e, t);
    expect(await rows(expected)).toBe(1);
    expect(await legacy(to)).toBe(0);
    expect(suppressedShare(await share(to))).toBe(true);
  });

  it("v2 Undo deletes the keyed row, once, and the person is emailed again", async () => {
    const { e, share, m } = await world(WITH_KEY);
    const to = uniq("u2", "gmail.com");
    const t = await signOptoutToken(e, to);
    await optOut(e, t);
    expect(await keyed(e, to)).toBe(1);
    expect(suppressedShare(await share(to))).toBe(true);
    expect((await undo(e, t)).status).toBe(200);
    expect(await keyed(e, to)).toBe(0);
    expect((await undo(e, t)).status).toBe(200);
    expect((await share(to)).emailed).toBe(true);
    expect(m.sent.filter((x) => x.to === to)).toHaveLength(1);
  });

  it("a legacy row still suppresses and is left in place (no rewrite)", async () => {
    const { e, share, m } = await world(WITH_KEY);
    const to = uniq("lg", "gmail.com");
    await env.DB.prepare(
      "insert into email_optouts (address_hash, created_at) values (?, ?)",
    )
      .bind(await addressHash(to), 1_700_000_000_000)
      .run();
    expect(suppressedShare(await share(to))).toBe(true);
    expect(suppressedShare(await share(to))).toBe(true);
    expect(m.sent.filter((x) => x.to === to)).toHaveLength(0);
    expect(await legacy(to)).toBe(1);
    expect(await keyed(e, to)).toBe(0);
  });

  it("a v1 link still opts out (a legacy row) and still undoes it, with the key set", async () => {
    const { e, share } = await world(WITH_KEY);
    const to = uniq("v1", "gmail.com");
    const t = await v1Token(e, to);
    expect(await verifyOptoutToken(e, t)).toBe(await addressHash(to));
    expect((await optOut(e, t)).status).toBe(200);
    expect(await legacy(to)).toBe(1);
    expect(await keyed(e, to)).toBe(0);
    expect(suppressedShare(await share(to))).toBe(true);
    // The done page offers Undo, and it works.
    expect((await undo(e, t)).status).toBe(200);
    expect(await legacy(to)).toBe(0);
    expect((await share(to)).emailed).toBe(true);
  });

  it("a mixed table: keyed, legacy and another address, each independent", async () => {
    const { e, share } = await world(WITH_KEY);
    const a = uniq("ma", "gmail.com");
    const b = uniq("mb", "gmail.com");
    const c = uniq("mc", "gmail.com");
    await optOut(e, await signOptoutToken(e, a));
    await optOut(e, await v1Token(e, b));
    expect(suppressedShare(await share(a))).toBe(true);
    expect(suppressedShare(await share(b))).toBe(true);
    expect((await share(c)).emailed).toBe(true);
    // Undoing A leaves B (and the reverse).
    await undo(e, await signOptoutToken(e, a));
    expect((await share(a)).emailed).toBe(true);
    expect(suppressedShare(await share(b))).toBe(true);
    await undo(e, await v1Token(e, b));
    expect((await share(b)).emailed).toBe(true);
  });

  it("a key added to a live install: old rows and old links keep working, new ones are keyed", async () => {
    const before = await world();
    const old = uniq("old", "gmail.com");
    const oldToken = await signOptoutToken(before.e, old);
    expect(oldToken.startsWith("v1.")).toBe(true);
    await optOut(before.e, oldToken);
    const fresh = uniq("new", "gmail.com");
    expect(await legacy(old)).toBe(1);
    // The key arrives.
    const after = await world(WITH_KEY);
    expect(suppressedShare(await after.share(old))).toBe(true);
    // The old email's link still undoes its legacy row.
    expect((await undo(after.e, oldToken)).status).toBe(200);
    expect(await legacy(old)).toBe(0);
    // A new person opts out on a v2 link: keyed.
    await after.share(fresh);
    await optOut(after.e, await signOptoutToken(after.e, fresh));
    expect(await keyed(after.e, fresh)).toBe(1);
    expect(await legacy(fresh)).toBe(0);
  });

  it("the key is never in a log line, a page, an audit row or a row", async () => {
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      }),
    );
    const { e, share } = await world(WITH_KEY);
    const to = uniq("sec", "gmail.com");
    await share(to);
    const t = await signOptoutToken(e, to);
    const pages: string[] = [];
    pages.push(await (await optOut(e, t)).text());
    pages.push(
      await (
        await app.fetch(
          new Request(`${APP}${SHARE_OPTOUT_PATH}?t=${t}`),
          e,
          ctx,
        )
      ).text(),
    );
    await share(to);
    pages.push(await (await undo(e, t)).text());
    pages.push(await (await optOut(e, "garbage")).text());
    for (const s of spies) s.mockRestore();
    const hex = [...KEY_BYTES]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const seen = [...lines, ...pages].join("\n");
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain(hex);
    const stored = await env.DB.prepare(
      "select group_concat(address_hash) h from email_optouts",
    ).first<{ h: string }>();
    const audits = await env.DB.prepare(
      "select group_concat(detail) d from audit_events",
    ).first<{ d: string }>();
    expect(`${stored?.h}${audits?.d}`).not.toContain(KEY);
    expect(`${stored?.h}${audits?.d}`).not.toContain(hex);
  });
});

describe("fail closed when the key goes missing", () => {
  const clearKeyed = () =>
    env.DB.prepare(
      "delete from email_optouts where address_hash >= 'k1:' and address_hash < 'k1;'",
    ).run();
  const captured = async (fn: () => Promise<unknown>) => {
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      }),
    );
    try {
      await fn();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    return lines;
  };

  it("a keyed row and the key removed: no send, the skipped shape, one optout_key_missing line", async () => {
    await clearKeyed();
    const keyedWorld = await world(WITH_KEY);
    const person = uniq("kp", "gmail.com");
    await optOut(keyedWorld.e, await signOptoutToken(keyedWorld.e, person));
    expect(await keyed(keyedWorld.e, person)).toBe(1);
    // The key is gone from this invocation.
    const { share, m } = await world();
    const stranger = uniq("st", "gmail.com");
    let out: Awaited<ReturnType<typeof share>> | undefined;
    const lines = await captured(async () => {
      out = await share(stranger);
    });
    expect(out).toMatchObject({ emailed: false, notEmailed: "skipped" });
    expect(m.sent.filter((x) => x.to === stranger)).toHaveLength(0);
    const evts = lines.filter((l) => l.includes("optout_key_"));
    expect(evts).toEqual([JSON.stringify({ evt: "optout_key_missing" })]);
    // Nothing about the address, a value or a length.
    expect(lines.join("\n")).not.toContain(stranger);
    await clearKeyed();
  });

  it("a keyed row and a key that is set but unusable: the same, with optout_key_invalid", async () => {
    await clearKeyed();
    const keyedWorld = await world(WITH_KEY);
    await optOut(
      keyedWorld.e,
      await signOptoutToken(keyedWorld.e, uniq("kq", "gmail.com")),
    );
    const bad = "invalid-key-value-xyz";
    const { share, m } = await world({ INSTALL_OPTOUT_KEY: bad });
    const stranger = uniq("sti", "gmail.com");
    let out: Awaited<ReturnType<typeof share>> | undefined;
    const lines = await captured(async () => {
      out = await share(stranger);
    });
    expect(out).toMatchObject({ emailed: false, notEmailed: "skipped" });
    expect(m.sent.filter((x) => x.to === stranger)).toHaveLength(0);
    expect(lines.filter((l) => l.includes("optout_key_"))).toEqual([
      JSON.stringify({ evt: "optout_key_invalid" }),
    ]);
    expect(lines.join("\n")).not.toContain(bad);
    expect(lines.join("\n")).not.toContain(stranger);
    await clearKeyed();
  });

  it("no keyed rows and no key: sends as today, and legacy rows alone don't trip it", async () => {
    await clearKeyed();
    const { share, m } = await world();
    const to = uniq("ok", "gmail.com");
    let out: Awaited<ReturnType<typeof share>> | undefined;
    const lines = await captured(async () => {
      out = await share(to);
    });
    expect(out?.emailed).toBe(true);
    expect(m.sent.filter((x) => x.to === to)).toHaveLength(1);
    expect(lines.filter((l) => l.includes("optout_key_"))).toEqual([]);
    // A legacy row alone is still just that row.
    const legacyTo = uniq("ol", "gmail.com");
    await env.DB.prepare(
      "insert into email_optouts (address_hash, created_at) values (?, ?)",
    )
      .bind(await addressHash(legacyTo), Date.now())
      .run();
    expect(suppressedShare(await share(legacyTo))).toBe(true);
    // With the key set, a keyed row never trips it.
    const k = await world(WITH_KEY);
    await optOut(k.e, await signOptoutToken(k.e, uniq("kk2", "gmail.com")));
    expect((await k.share(uniq("fine", "gmail.com"))).emailed).toBe(true);
    await clearKeyed();
  });

  it("a person at a login domain (not outside) is unaffected by the missing key", async () => {
    await clearKeyed();
    const keyedWorld = await world(WITH_KEY);
    await optOut(
      keyedWorld.e,
      await signOptoutToken(keyedWorld.e, uniq("kr", "gmail.com")),
    );
    const { share } = await world();
    const memberEmail = uniq("inside", "a.com");
    await login(memberEmail, "member");
    const r = await share(memberEmail);
    expect(r.notEmailed).toBeUndefined();
    await clearKeyed();
  });
});
