// #2590: "Don't email me again" in the outside share email.
import { env } from "cloudflare:workers";
import { R, ShareResultSchema } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  addressHash,
  optoutUrl,
  SHARE_OPTOUT_PATH,
  signOptoutToken,
  verifyOptoutToken,
} from "../src/email/share-optout.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const APP = "http://app.localhost";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

const HOSTED: Partial<Env> = {
  HOSTED: "1",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
};

const hit = (method: string, path: string, e: Env = env as Env) =>
  app.fetch(new Request(`${APP}${path}`, { method }), e, ctx);
const suppressed = async (email: string) =>
  (await env.DB.prepare("select 1 from email_optouts where address_hash = ?")
    .bind(await addressHash(email))
    .first()) !== null;
const tokenOf = (url: string) => new URL(url).searchParams.get("t") ?? "";

async function world(over: Partial<Env> = HOSTED) {
  const m = mailer();
  const e = direct({ ...m.env, ...over }) as Env;
  const o = await login(uniq("own", "a.com"), "member");
  const member = await getUser(env, o.userId);
  if (!member) throw new Error("no user");
  // Each share is on a new page: a re-share of the same page sends nothing.
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

describe("the opt-out token", () => {
  it("round trips, names the address's hash, and is one purpose", async () => {
    const email = uniq("tok", "gmail.com");
    const t = await signOptoutToken(env, email);
    expect(await verifyOptoutToken(env, t)).toBe(await addressHash(email));
    // The link never carries the address.
    expect(t).not.toContain("@");
    expect(t).not.toContain(email.split("@")[0] as string);
    // Another purpose's token (the comment-email one) never verifies here.
    expect(await verifyOptoutToken(env, "v1.someone.abcdef")).toBeNull();
  });

  it("forged, edited and wrong-address tokens are refused", async () => {
    const a = uniq("a", "gmail.com");
    const b = uniq("b", "gmail.com");
    const [v, hashA, sigA] = (await signOptoutToken(env, a)).split(".") as [
      string,
      string,
      string,
    ];
    const hashB = (await addressHash(b)) as string;
    // A's signature on B's hash: the wrong address.
    expect(await verifyOptoutToken(env, `${v}.${hashB}.${sigA}`)).toBeNull();
    // A flipped signature, a version bump, extra parts, junk.
    expect(
      await verifyOptoutToken(env, `${v}.${hashA}.${sigA.slice(0, -2)}xx`),
    ).toBeNull();
    expect(await verifyOptoutToken(env, `v2.${hashA}.${sigA}`)).toBeNull();
    expect(await verifyOptoutToken(env, `${v}.${hashA}.${sigA}.x`)).toBeNull();
    expect(await verifyOptoutToken(env, "")).toBeNull();
    expect(await verifyOptoutToken(env, "garbage")).toBeNull();
  });
});

describe("the opt-out page", () => {
  it("GET shows one button and changes nothing; POST suppresses; it is idempotent", async () => {
    const email = uniq("pg", "gmail.com");
    const t = await signOptoutToken(env, email);
    const path = `${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(t)}`;
    const g = await hit("GET", path);
    expect(g.status).toBe(200);
    const csp = g.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await g.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain("Stop emails from Open Artifacts?");
    expect(html).toContain(
      "We won&#39;t email you again when someone at Open Artifacts shares a page with you. Other teams on Open Artifacts can still email you.",
    );
    expect(html).toContain(">Stop emails from Open Artifacts</button>");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(await suppressed(email)).toBe(false);
    // A scanner prefetching again: still nothing.
    await hit("GET", path);
    expect(await suppressed(email)).toBe(false);
    // The POST (the button, or RFC 8058 one-click with the token in the URL).
    const p = await hit("POST", path);
    expect(p.status).toBe(200);
    const done = await p.text();
    expect(done).toContain(
      "You won&#39;t get share emails from Open Artifacts anymore.",
    );
    expect(done).toContain(
      "Pages shared with you still open when you log in. We just won&#39;t email you about them.",
    );
    expect(await suppressed(email)).toBe(true);
    expect((await hit("POST", path)).status).toBe(200);
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from email_optouts where address_hash = ?",
        )
          .bind(await addressHash(email))
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("a forged token is refused on both: 400, nothing written", async () => {
    const email = uniq("bad", "gmail.com");
    const t = await signOptoutToken(env, email);
    const forged = `${t.slice(0, -3)}abc`;
    const before = (
      await env.DB.prepare("select count(*) n from email_optouts").first<{
        n: number;
      }>()
    )?.n;
    for (const method of ["GET", "POST"]) {
      const r = await hit(method, `${SHARE_OPTOUT_PATH}?t=${forged}`);
      expect(r.status).toBe(400);
      const body = await r.text();
      expect(body).toContain("This link is not valid");
      expect(body).toContain(
        "This link doesn&#39;t work. Open the most recent email from us and use the link there.",
      );
    }
    expect((await hit("POST", SHARE_OPTOUT_PATH)).status).toBe(400);
    expect(await suppressed(email)).toBe(false);
    expect(
      (
        await env.DB.prepare("select count(*) n from email_optouts").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(before);
  });
});

describe("the instance name in the opt-out words", () => {
  const setName = (name: string) =>
    env.DB.prepare(
      "insert into settings (key, value) values ('name', ?) on conflict (key) do update set value = excluded.value",
    )
      .bind(name)
      .run();

  it("a name that looks like a URL is replaced by the host, in the email and on the page", async () => {
    const t = await signOptoutToken(env, uniq("nm", "gmail.com"));
    const path = `${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(t)}`;
    try {
      for (const name of [
        "https://evil.example/x",
        "www.evil.example",
        "Acme evil.example Co",
      ]) {
        await setName(name);
        const page = await (await hit("GET", path)).text();
        expect(page, name).not.toContain("evil.example");
        expect(page, name).toContain(`Stop emails from ${env.APP_HOST}?`);
        const { m, share } = await world();
        const to = uniq("nm", "gmail.com");
        await share(to);
        const mail = m.sent.find((x) => x.to === to);
        expect(mail?.html, name).not.toContain("evil.example");
        expect(mail?.text, name).not.toContain("evil.example");
        expect(mail?.text, name).toContain(
          `Don't email me from ${env.APP_HOST} again:`,
        );
      }
      // A plain name stays.
      await setName("Acme Co");
      expect(await (await hit("GET", path)).text()).toContain(
        "Stop emails from Acme Co?",
      );
    } finally {
      await env.DB.prepare("delete from settings where key = 'name'").run();
    }
  });
});

describe("the email and the opt-out", () => {
  it("carries the link and the RFC 8058 headers; a POST on the link stops later shares", async () => {
    const { m, share } = await world();
    const to = uniq("opt", "gmail.com");
    expect(await share(to)).toMatchObject({ emailed: true });
    const mail = m.sent.find((x) => x.to === to);
    const unsub = mail?.headers?.["List-Unsubscribe"] ?? "";
    expect(unsub).toMatch(/^<https:\/\/.+\/auth\/unsubscribe\/shares\?t=.+>$/);
    expect(mail?.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    const url = unsub.slice(1, -1);
    // The header's URL is the footer link, and the token names this address.
    expect(mail?.html).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
    expect(mail?.html).toContain(
      ">Don&#39;t email me from Open Artifacts again</a>",
    );
    expect(mail?.text).toContain("Don't email me from Open Artifacts again:");
    expect(await verifyOptoutToken(env, tokenOf(url))).toBe(
      await addressHash(to),
    );
    expect(optoutUrl(env.APP_HOST, tokenOf(url))).toBe(url);
    // One click, and the next share is saved but not emailed.
    expect(
      (await hit("POST", new URL(url).pathname + new URL(url).search)).status,
    ).toBe(200);
    const log = vi.spyOn(console, "log");
    const again = await share(to);
    // The sharer is told "skipped", never why; the log has the reason.
    expect(JSON.stringify(again)).not.toContain("opted");
    expect(
      log.mock.calls.some((c) =>
        String(c[0]).includes('"reason":"recipient_opted_out"'),
      ),
    ).toBe(true);
    log.mockRestore();
    expect(again).toMatchObject({
      emailed: false,
      notEmailed: "skipped",
    });
    expect(m.sent.filter((x) => x.to === to)).toHaveLength(1);
    // Another address is not affected.
    const other = uniq("other", "gmail.com");
    expect(await share(other)).toMatchObject({ emailed: true });
  });

  it("self-host too", async () => {
    const { share } = await world({});
    const to = uniq("sh", "gmail.com");
    await share(to);
    await hit(
      "POST",
      `${SHARE_OPTOUT_PATH}?t=${await signOptoutToken(env, to)}`,
    );
    expect(await share(to)).toMatchObject({
      emailed: false,
      notEmailed: "skipped",
    });
  });
});

describe("the recipient's undo (#2653)", () => {
  const form = (body: Record<string, string>) =>
    app.fetch(
      new Request(`${APP}${SHARE_OPTOUT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      }),
      env as Env,
      ctx,
    );
  const undo = (t: string) => form({ t, action: "undo" });
  const optOut = (t: string) => form({ t });
  it("the done page offers Undo; Undo removes only that address's row and says you'll get the emails again", async () => {
    const email = uniq("un", "gmail.com");
    const other = uniq("ot", "gmail.com");
    const t = await signOptoutToken(env, email);
    const ot = await signOptoutToken(env, other);
    const done = await (await optOut(t)).text();
    expect(done).toContain(
      "You won&#39;t get share emails from Open Artifacts anymore.",
    );
    expect(done).toContain('name="action" value="undo"');
    expect(done).toContain(">Undo</button>");
    await optOut(ot);
    expect(await suppressed(email)).toBe(true);
    const r = await undo(t);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(
      "You&#39;ll get share emails from Open Artifacts again.",
    );
    expect(html).not.toContain("<button");
    expect(await suppressed(email)).toBe(false);
    // Another address is untouched.
    expect(await suppressed(other)).toBe(true);
    // An opt-out again works, and so does undoing again.
    await optOut(t);
    expect(await suppressed(email)).toBe(true);
    expect((await undo(t)).status).toBe(200);
    expect(await suppressed(email)).toBe(false);
  });

  it("is idempotent, and audits once per row actually removed: by the recipient, with no hash and no address", async () => {
    const email = uniq("au", "gmail.com");
    const t = await signOptoutToken(env, email);
    const hash = (await addressHash(email)) as string;
    const audits = async () =>
      (
        await env.DB.prepare(
          "select actor_id, target_id, detail from audit_events where action = 'settings.change' and instr(detail, 'optoutRemoved') > 0",
        ).all<{ actor_id: string | null; target_id: string; detail: string }>()
      ).results;
    const before = (await audits()).length;
    // The opt-out itself writes no audit row.
    await optOut(t);
    expect((await audits()).length).toBe(before);
    await undo(t);
    await undo(t);
    const rows = (await audits()).slice(before);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({
      by: "recipient",
      optoutRemoved: true,
    });
    // Neither the hash nor the address is anywhere in the audit log.
    const all = await env.DB.prepare(
      "select count(*) n from audit_events where instr(detail, ?1) > 0 or instr(detail, ?2) > 0 or instr(target_id, ?1) > 0 or instr(target_id, ?2) > 0",
    )
      .bind(hash, email)
      .first<{ n: number }>();
    expect(all?.n).toBe(0);
    // Undoing an address that never opted out writes nothing.
    const n = (await audits()).length;
    await undo(await signOptoutToken(env, uniq("nv", "gmail.com")));
    expect((await audits()).length).toBe(n);
  });

  it("a later visit to the same link, while opted out, shows the page with Undo, and a GET changes nothing", async () => {
    const email = uniq("lv", "gmail.com");
    const t = await signOptoutToken(env, email);
    const path = `${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(t)}`;
    // Not opted out: the confirm page.
    expect(await (await hit("GET", path)).text()).toContain(
      "Stop emails from Open Artifacts?",
    );
    await optOut(t);
    const g = await hit("GET", path);
    const html = await g.text();
    expect(html).toContain(
      "You won&#39;t get share emails from Open Artifacts anymore.",
    );
    expect(html).toContain('name="action" value="undo"');
    // A GET, even one that asks for the undo, never mutates.
    await hit("GET", `${path}&action=undo`);
    await hit("GET", path);
    expect(await suppressed(email)).toBe(true);
    // The Undo from that page works.
    await undo(t);
    expect(await suppressed(email)).toBe(false);
    expect(await (await hit("GET", path)).text()).toContain(
      "Stop emails from Open Artifacts?",
    );
  });

  it("a bad or missing token is refused, and the opt-out stays", async () => {
    const email = uniq("bt", "gmail.com");
    const t = await signOptoutToken(env, email);
    await optOut(t);
    for (const bad of [
      `${t.slice(0, -3)}abc`,
      "garbage",
      "",
      `v2.${t.split(".").slice(1).join(".")}`,
    ]) {
      const r = await undo(bad);
      expect(r.status).toBe(400);
      expect(await r.text()).toContain("This link is not valid");
    }
    // Another address's valid token can't remove this one.
    await undo(await signOptoutToken(env, uniq("zz", "gmail.com")));
    expect(await suppressed(email)).toBe(true);
    // The token in the URL with no action is still an opt-out, not an undo.
    await form({ t: "x" });
    expect(await suppressed(email)).toBe(true);
  });

  it("the team name is escaped on the done and undone pages", async () => {
    const email = uniq("es", "gmail.com");
    const t = await signOptoutToken(env, email);
    try {
      await env.DB.prepare(
        "insert into settings (key, value) values ('name', ?) on conflict (key) do update set value = excluded.value",
      )
        .bind("Tom & <i>Jerry</i>")
        .run();
      const done = await (await optOut(t)).text();
      expect(done).toContain(
        "You won&#39;t get share emails from Tom &amp; &lt;i&gt;Jerry&lt;/i&gt; anymore.",
      );
      const undone = await (await undo(t)).text();
      expect(undone).toContain(
        "You&#39;ll get share emails from Tom &amp; &lt;i&gt;Jerry&lt;/i&gt; again.",
      );
      expect(done + undone).not.toContain("<i>");
    } finally {
      await env.DB.prepare("delete from settings where key = 'name'").run();
    }
  });

  it("no other way in: there is no admin route for it", async () => {
    const r = await app.fetch(
      new Request(`${APP}/api/v1/settings/outside-share-optouts`, {
        method: "DELETE",
      }),
      env as Env,
      ctx,
    );
    expect(r.status).toBe(404);
  });
});
