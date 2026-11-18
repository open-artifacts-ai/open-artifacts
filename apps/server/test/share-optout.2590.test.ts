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
      "You won&#39;t get emails from Open Artifacts again.",
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

describe("every non-send to an outside address that isn't a cap reads 'skipped' (#2716)", () => {
  it("an opt-out and a failed send answer the same; a member stays plain", async () => {
    const down = mailer();
    const failing = {
      ...down.env,
      EMAIL: {
        send: async () => {
          throw Object.assign(new Error("boom"), { code: "E_DOWN" });
        },
      } as unknown as SendEmail,
    };
    const f = await world({ ...HOSTED, ...failing });
    const failed = await f.share(uniq("fail", "gmail.com"));
    const { share } = await world();
    const to = uniq("oo", "gmail.com");
    await share(to);
    await hit(
      "POST",
      `${SHARE_OPTOUT_PATH}?t=${await signOptoutToken(env, to)}`,
    );
    const optedOut = await share(to);
    expect(failed).toMatchObject({ emailed: false, notEmailed: "skipped" });
    expect(optedOut).toMatchObject({ emailed: false, notEmailed: "skipped" });
    // Same shape, no extra field that tells them apart.
    const shape = (r: object) => Object.keys(r).sort().join(",");
    expect(shape(optedOut)).toBe(shape(failed));
    // A member is not an outside address: a plain non-send, no reason.
    const memberEmail = uniq("mem", "a.com");
    await login(memberEmail, "member");
    const plain = await share(memberEmail);
    expect(plain.emailed).toBe(false);
    expect(plain.notEmailed).toBeUndefined();
  });
});
