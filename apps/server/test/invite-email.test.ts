import { env } from "cloudflare:workers";
import {
  MemberInviteResultSchema,
  MeSchema,
  newId,
  R,
  ShareResultSchema,
} from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import {
  MAX_EMAILS_PER_DAY,
  MAX_EMAILS_PER_RECIPIENT_PER_DAY,
  MAX_EMAILS_PER_USER_PER_DAY,
  sendEmail,
  sweepEmailCounters,
} from "../src/email/send.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";
import { connect, E, textOf, tool } from "./mcp-helpers.js";
import { pinMiddayUtc } from "./midday.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const FROM = "noreply@mail.example.com";
const today = () => new Date().toISOString().slice(0, 10);

type Sent = {
  from: string | { email: string; name: string };
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** A mock `send_email` binding; `fail` makes send() reject. */
function mailer(fail = false) {
  const sent: Sent[] = [];
  return {
    sent,
    EMAIL: {
      async send(m: Sent) {
        if (fail) throw new Error("E_SENDER_NOT_VERIFIED");
        sent.push(m);
        return { messageId: "m1" };
      },
    },
  };
}

const call = (
  e: object,
  path: string,
  cookie: string,
  method: string,
  body: unknown,
) =>
  app.fetch(
    new Request(`http://app.localhost${path}`, {
      method,
      headers: {
        cookie,
        "x-oa-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { ...(env as object), ...e } as never,
    ctx,
  );

const fresh = () => `e-${newId().slice(0, 8).toLowerCase()}@x.com`;
const invite = (e: object, cookie: string, email = fresh()) =>
  call(e, R.members, cookie, "POST", { email, role: "member" });

async function newOwner() {
  const l = await login(fresh(), "owner");
  return l;
}

beforeEach(async () => {
  // Seeds use today(); the server reads its own Date.now(): pin both to
  // midday UTC so a run across 00:00 UTC can't split them.
  pinMiddayUtc();
  await env.DB.prepare("delete from counters where key like 'email:%'").run();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Me.instance.emailEnabled", () => {
  it("true only when EMAIL and EMAIL_FROM are both set", async () => {
    const o = await newOwner();
    const { EMAIL } = mailer();
    const cases: [object, boolean][] = [
      [{ EMAIL, EMAIL_FROM: FROM }, true],
      [{ EMAIL_FROM: FROM }, false],
      [{ EMAIL }, false],
      [{}, false],
    ];
    for (const [e, want] of cases) {
      const r = await app.fetch(
        new Request(`http://app.localhost${R.me}`, {
          headers: { cookie: o.cookie },
        }),
        { ...(env as object), ...e } as never,
        ctx,
      );
      expect(r.status).toBe(200);
      expect(MeSchema.parse(await r.json()).instance.emailEnabled).toBe(want);
    }
  });
});

describe("invite email", () => {
  it("sends one email and returns emailed:true", async () => {
    const o = await newOwner();
    const m = mailer();
    const email = fresh();
    const r = await invite({ ...m, EMAIL_FROM: FROM }, o.cookie, email);
    expect(r.status).toBe(201);
    const body = MemberInviteResultSchema.parse(await r.json());
    expect(body.emailed).toBe(true);
    expect(m.sent).toHaveLength(1);
    const s = m.sent[0] as Sent;
    expect(s.to).toBe(email);
    expect(s.from).toEqual({ email: FROM, name: "Open Artifacts" });
    expect(s.text).toContain("https://app.localhost/sign-in");
    expect(s.html).toContain('href="https://app.localhost/sign-in"');
    expect(s.subject).toContain("added you to");
  });

  it("missing EMAIL or EMAIL_FROM gives emailed:false", async () => {
    const o = await newOwner();
    const m = mailer();
    for (const e of [{ EMAIL_FROM: FROM }, { EMAIL: m.EMAIL }, {}]) {
      const r = await invite(e, o.cookie);
      expect(r.status).toBe(201);
      expect(((await r.json()) as { emailed: boolean }).emailed).toBe(false);
    }
    expect(m.sent).toHaveLength(0);
  });

  it("a send that throws gives emailed:false and the invite still exists", async () => {
    const o = await newOwner();
    const email = fresh();
    const r = await invite(
      { ...mailer(true), EMAIL_FROM: FROM },
      o.cookie,
      email,
    );
    expect(r.status).toBe(201);
    expect(((await r.json()) as { emailed: boolean }).emailed).toBe(false);
    const row = await env.DB.prepare("select 1 as x from users where email = ?")
      .bind(email)
      .first();
    expect(row).not.toBeNull();
  });

  it(`caps each inviter at ${MAX_EMAILS_PER_USER_PER_DAY} a day`, async () => {
    const o = await newOwner();
    const m = mailer();
    const e = { ...m, EMAIL_FROM: FROM };
    await env.DB.prepare("insert into counters (key, n, day) values (?, ?, ?)")
      .bind(`email:${o.userId}`, MAX_EMAILS_PER_USER_PER_DAY - 1, today())
      .run();
    const last = await invite(e, o.cookie);
    expect(((await last.json()) as { emailed: boolean }).emailed).toBe(true);
    const over = await invite(e, o.cookie);
    expect(over.status).toBe(201);
    expect(((await over.json()) as { emailed: boolean }).emailed).toBe(false);
    expect(m.sent).toHaveLength(1);
    // Another inviter is unaffected.
    const o2 = await newOwner();
    const r2 = await invite(e, o2.cookie);
    expect(((await r2.json()) as { emailed: boolean }).emailed).toBe(true);
  });

  it("30 concurrent invites from one owner send exactly the per-user cap", async () => {
    const o = await newOwner();
    const m = mailer();
    const e = { ...m, EMAIL_FROM: FROM };
    const rs = await Promise.all(
      Array.from({ length: 30 }, () => invite(e, o.cookie)),
    );
    const bodies = (await Promise.all(rs.map((r) => r.json()))) as {
      emailed: boolean;
    }[];
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(bodies.filter((b) => b.emailed).length).toBe(
      MAX_EMAILS_PER_USER_PER_DAY,
    );
    expect(m.sent).toHaveLength(MAX_EMAILS_PER_USER_PER_DAY);
  });

  it("yesterday's count does not apply today", async () => {
    const o = await newOwner();
    const m = mailer();
    await env.DB.prepare("insert into counters (key, n, day) values (?, ?, ?)")
      .bind(`email:${o.userId}`, MAX_EMAILS_PER_USER_PER_DAY, "2000-01-01")
      .run();
    const r = await invite({ ...m, EMAIL_FROM: FROM }, o.cookie);
    expect(((await r.json()) as { emailed: boolean }).emailed).toBe(true);
  });

  it(`caps the instance at ${MAX_EMAILS_PER_DAY} a day`, async () => {
    const o = await newOwner();
    const m = mailer();
    await env.DB.prepare("insert into counters (key, n, day) values (?, ?, ?)")
      .bind("email:*", MAX_EMAILS_PER_DAY, today())
      .run();
    const r = await invite({ ...m, EMAIL_FROM: FROM }, o.cookie);
    expect(r.status).toBe(201);
    expect(((await r.json()) as { emailed: boolean }).emailed).toBe(false);
    expect(m.sent).toHaveLength(0);
  });

  it("escapes names in HTML and strips CR/LF from the subject and text", async () => {
    const o = await newOwner();
    await env.DB.prepare("update users set name = ? where id = ?")
      .bind("Mal<script>alert(1)</script>\r\nBcc: evil@x.com", o.userId)
      .run();
    await env.DB.prepare(
      "insert or replace into settings (key, value) values ('name', ?)",
    )
      .bind("Acme & <Co>\r\nX-Evil: 1")
      .run();
    const m = mailer();
    await invite({ ...m, EMAIL_FROM: FROM }, o.cookie);
    const s = m.sent[0] as Sent;
    expect(s.html).not.toContain("<script>");
    expect(s.html).toContain("&lt;script&gt;");
    expect(s.html).toContain("Acme &amp; &lt;Co&gt;");
    expect(s.subject).not.toMatch(/[\r\n]/);
    expect(s.subject.length).toBeLessThanOrEqual(150);
    expect(s.text).not.toContain("\r\nBcc");
    expect(s.text).not.toContain("\nX-Evil");
    expect(s.html).not.toContain("\nBcc");
    await env.DB.prepare("delete from settings where key = 'name'").run();
  });
});

describe("share email", () => {
  async function setup() {
    const o = await newOwner();
    const owner = await getUser(env, o.userId);
    if (!owner) throw new Error("no user");
    const { id } = await publish(
      env,
      owner,
      {
        title: 'Plan <img src=x onerror="1">',
        visibility: "private",
        format: "markdown",
        content: "x",
      } as never,
      null,
      undefined,
      "create",
    );
    return { o, id };
  }

  it("emails a non-member once, with an escaped title and an https link", async () => {
    const { o, id } = await setup();
    const m = mailer();
    const e = { ...m, EMAIL_FROM: FROM };
    const email = fresh();
    const r = await call(e, R.shares(id), o.cookie, "PUT", {
      email,
      role: "viewer",
    });
    expect(r.status).toBe(200);
    expect(ShareResultSchema.parse(await r.json()).emailed).toBe(true);
    const s = m.sent[0] as Sent;
    expect(s.to).toBe(email);
    expect(s.html).toContain("Plan &lt;img");
    expect(s.html).not.toContain("<img src=x");
    expect(s.html).toContain(`href="https://app.localhost/a/${id}"`);
    // A role change on the existing share sends nothing.
    const again = await call(e, R.shares(id), o.cookie, "PUT", {
      email,
      role: "editor",
    });
    expect(((await again.json()) as { emailed: boolean }).emailed).toBe(false);
    expect(m.sent).toHaveLength(1);
  });

  it("does not email an existing member", async () => {
    const { o, id } = await setup();
    const member = fresh();
    await login(member);
    const m = mailer();
    const r = await call(
      { ...m, EMAIL_FROM: FROM },
      R.shares(id),
      o.cookie,
      "PUT",
      {
        email: member,
        role: "viewer",
      },
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { emailed: boolean }).emailed).toBe(false);
    expect(m.sent).toHaveLength(0);
  });

  it("share_artifact says whether it emailed", async () => {
    const { o, id } = await setup();
    const pat = (await createPat(env, o.userId, "agent")).token;
    const m = mailer();
    const client = await connect(pat, { env: E({ ...m, EMAIL_FROM: FROM }) });
    const email = fresh();
    const r = await tool(client, "share_artifact", {
      id,
      email,
      role: "viewer",
    });
    expect(r.structuredContent?.emailed).toBe(true);
    expect(textOf(r)).toContain(`Emailed ${email} a link.`);
    const r2 = await tool(client, "share_artifact", {
      id,
      email,
      role: "editor",
    });
    expect(r2.structuredContent?.emailed).toBe(false);
    expect(textOf(r2)).toContain("No email sent.");
    await client.close();
  });

  it("removing and re-adding a share 3 times sends one email", async () => {
    const { o, id } = await setup();
    const m = mailer();
    const e = { ...m, EMAIL_FROM: FROM };
    const email = fresh();
    const emailed: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call(e, R.shares(id), o.cookie, "PUT", {
        email,
        role: "viewer",
      });
      emailed.push(((await r.json()) as { emailed: boolean }).emailed);
      const d = await call(
        e,
        R.share(id, email),
        o.cookie,
        "DELETE",
        undefined,
      );
      expect(d.status).toBe(204);
    }
    expect(emailed).toEqual([true, false, false]);
    expect(m.sent).toHaveLength(1);
  });

  it(`emails one address at most ${MAX_EMAILS_PER_RECIPIENT_PER_DAY} times a day across artifacts`, async () => {
    const m = mailer();
    const e = { ...m, EMAIL_FROM: FROM };
    const email = fresh();
    const emailed: boolean[] = [];
    for (let i = 0; i <= MAX_EMAILS_PER_RECIPIENT_PER_DAY; i++) {
      const { o, id } = await setup();
      const r = await call(e, R.shares(id), o.cookie, "PUT", {
        email,
        role: "viewer",
      });
      expect(r.status).toBe(200);
      emailed.push(((await r.json()) as { emailed: boolean }).emailed);
    }
    expect(emailed.filter(Boolean).length).toBe(
      MAX_EMAILS_PER_RECIPIENT_PER_DAY,
    );
    expect(emailed.at(-1)).toBe(false);
    expect(m.sent).toHaveLength(MAX_EMAILS_PER_RECIPIENT_PER_DAY);
  });
});

it("the cron sweep drops only past days' email counters", async () => {
  await env.DB.batch([
    env.DB.prepare(
      "insert into counters (key, n, day) values ('email:old', 1, '2000-01-01')",
    ),
    env.DB.prepare(
      "insert into counters (key, n, day) values ('email:new', 1, ?)",
    ).bind(today()),
    env.DB.prepare(
      "insert or replace into counters (key, n, day) values ('client:keep', 0, '2000-01-01')",
    ),
  ]);
  await sweepEmailCounters(env as never);
  const { results } = await env.DB.prepare(
    "select key from counters where key in ('email:old', 'email:new', 'client:keep') order by key",
  ).all<{ key: string }>();
  expect(results.map((r) => r.key)).toEqual(["client:keep", "email:new"]);
});

describe("one recipient per send", () => {
  // Addresses with RFC specials that a list parser could split or reinterpret.
  const SPECIAL = [
    '"a,b"@x.com',
    "a,b@x.com",
    "a@x.com,b@y.com",
    "a;b@x.com",
    "<a@x.com>",
    "a(b)@x.com",
    '"a@x.com"@y.com',
  ];

  it("invites and shares reject them at validation (400), sending nothing", async () => {
    const o = await newOwner();
    const owner = await getUser(env, o.userId);
    if (!owner) throw new Error("no user");
    const m = mailer();
    const e = { ...m, EMAIL_FROM: FROM };
    for (const addr of SPECIAL) {
      const before = m.sent.length;
      const inv = await invite(e, o.cookie, addr);
      expect(inv.status, addr).toBe(400);
      const { id } = await publish(
        env,
        owner,
        {
          title: "t",
          visibility: "private",
          format: "markdown",
          content: "x",
        } as never,
        null,
        undefined,
        "create",
      );
      const sh = await call(e, R.shares(id), o.cookie, "PUT", {
        email: addr,
        role: "viewer",
      });
      expect(sh.status, addr).toBe(400);
      expect(m.sent.length).toBe(before);
    }
  });

  it("sendEmail itself refuses any `to` that is not one plain address", async () => {
    const m = mailer();
    const e = { ...(env as object), ...m, EMAIL_FROM: FROM } as never;
    const content = () => ({ subject: "s", text: "t", html: "h" });
    for (const addr of SPECIAL)
      expect(
        await sendEmail(e, "u-special", addr, content, {
          kind: "invite",
          instance: null,
        }),
        addr,
      ).toBe(false);
    expect(m.sent).toHaveLength(0);
    expect(
      await sendEmail(e, "u-special", "a+b@x.com", content, {
        kind: "invite",
        instance: null,
      }),
    ).toBe(true);
    expect(m.sent.map((s) => s.to)).toEqual(["a+b@x.com"]);
  });
});

describe("email logs", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Every console line written while `fn` runs. */
  async function captured(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        lines.push(
          a
            .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
            .join(" "),
        );
      });
    await fn();
    return lines;
  }
  const content = () => ({
    subject: "Secret subject",
    text: "victim body",
    html: "<p>victim body</p>",
  });
  const leaks = (lines: string[]) =>
    lines.filter((l) => /@|victim|example\.com|Secret|noreply/i.test(l));

  it("logs email_sent with the messageId and nothing identifying", async () => {
    const e = {
      ...(env as object),
      EMAIL_FROM: "Open Artifacts <noreply@mail.example.com>",
      EMAIL: { send: async () => ({ messageId: "msg-123abc" }) },
    } as never;
    const lines = await captured(() =>
      sendEmail(e, "u-log1", "victim@example.com", content, {
        kind: "share",
        instance: null,
      }),
    );
    const sent = lines.find((l) => l.includes('"email_sent"'));
    expect(sent).toBeDefined();
    expect(JSON.parse(sent as string)).toEqual({
      evt: "email_sent",
      kind: "share",
      messageId: "msg-123abc",
    });
    expect(leaks(lines)).toEqual([]);
  });

  it("logs email_failed with a short reason and no address", async () => {
    const err = Object.assign(
      new Error("rejected victim@example.com: sender not verified"),
      { code: "E_SENDER_NOT_VERIFIED" },
    );
    const e = {
      ...(env as object),
      EMAIL_FROM: FROM,
      EMAIL: {
        send: async () => {
          throw err;
        },
      },
    } as never;
    const lines = await captured(() =>
      sendEmail(e, "u-log2", "victim@example.com", content, {
        kind: "invite",
        instance: null,
      }),
    );
    const failed = lines.find((l) => l.includes('"email_failed"'));
    expect(JSON.parse(failed as string)).toEqual({
      evt: "email_failed",
      kind: "invite",
      reason: "E_SENDER_NOT_VERIFIED",
    });
    expect(leaks(lines)).toEqual([]);
    // An error without a code-like `code` falls back to a generic reason.
    const e2 = {
      ...(env as object),
      EMAIL_FROM: FROM,
      EMAIL: {
        send: async () => {
          throw new Error("victim@example.com bounced");
        },
      },
    } as never;
    const lines2 = await captured(() =>
      sendEmail(e2, "u-log3", "victim@example.com", content, {
        kind: "invite",
        instance: null,
      }),
    );
    expect(lines2.some((l) => l.includes('"reason":"send_error"'))).toBe(true);
    expect(leaks(lines2)).toEqual([]);
  });
});

describe("sender name in emails", () => {
  const setName = (id: string, name: string) =>
    env.DB.prepare("update users set name = ? where id = ?")
      .bind(name, id)
      .run();

  async function both(o: { cookie: string; userId: string }) {
    const m = mailer();
    const e = { ...m, EMAIL_FROM: FROM };
    await invite(e, o.cookie);
    const owner = await getUser(env, o.userId);
    if (!owner) throw new Error("no user");
    const { id } = await publish(
      env,
      owner,
      {
        title: "T",
        visibility: "private",
        format: "markdown",
        content: "x",
      } as never,
      null,
      undefined,
      "create",
    );
    await call(e, R.shares(id), o.cookie, "PUT", {
      email: fresh(),
      role: "viewer",
    });
    expect(m.sent).toHaveLength(2);
    return m.sent;
  }

  // login() stores the default name (the email's local part), like a first
  // sign-in without a display name; "" and whitespace are also "no name".
  for (const [label, name] of [
    ["the default local-part name", null],
    ["an empty name", ""],
    ["a whitespace-only name", "   "],
  ] as const)
    it(`${label} uses the full email address`, async () => {
      const email = fresh();
      const o = await login(email, "owner");
      if (name !== null) await setName(o.userId, name);
      for (const s of await both(o)) {
        expect(s.subject.startsWith(`${email} `), s.subject).toBe(true);
        expect(s.text.startsWith(`${email} `)).toBe(true);
        expect(s.html).toContain(`>${email} `);
        expect(s.html).not.toMatch(new RegExp(`>${email.split("@")[0]} `));
      }
    });

  it("a display name is used (trimmed)", async () => {
    const o = await newOwner();
    await setName(o.userId, "  Ada Lovelace ");
    for (const s of await both(o)) {
      expect(s.subject.startsWith("Ada Lovelace ")).toBe(true);
      expect(s.text.startsWith("Ada Lovelace ")).toBe(true);
      expect(s.html).toContain(">Ada Lovelace ");
    }
  });
});

describe("deliverability headers (#213)", () => {
  it("From is the product name on EMAIL_FROM; Reply-To is the inviter or sharer", async () => {
    const email = fresh();
    const o = await login(email, "owner");
    const m = mailer();
    const e = { ...m, EMAIL_FROM: FROM };
    await invite(e, o.cookie);
    const owner = await getUser(env, o.userId);
    if (!owner) throw new Error("no user");
    const { id } = await publish(
      env,
      owner,
      {
        title: "T",
        visibility: "private",
        format: "markdown",
        content: "x",
      } as never,
      null,
      undefined,
      "create",
    );
    await call(e, R.shares(id), o.cookie, "PUT", {
      email: fresh(),
      role: "viewer",
    });
    expect(m.sent).toHaveLength(2);
    for (const s of m.sent) {
      expect(s.from).toEqual({ email: FROM, name: "Open Artifacts" });
      expect(s.replyTo).toBe(email);
      expect(s.text.length).toBeGreaterThan(0);
    }
  });

  it("Reply-To is omitted unless it is one plain address", async () => {
    const m = mailer();
    const e = { ...(env as object), ...m, EMAIL_FROM: FROM } as never;
    const content = () => ({ subject: "s", text: "t", html: "h" });
    await sendEmail(e, "u-rt1", "a@x.com", content, {
      kind: "invite",
      instance: null,
      replyTo: "x@y.com, evil@z.com",
    });
    await sendEmail(e, "u-rt2", "b@x.com", content, {
      kind: "invite",
      instance: null,
      replyTo: "ok@y.com",
    });
    expect(m.sent.map((s) => s.replyTo)).toEqual([undefined, "ok@y.com"]);
    expect("replyTo" in (m.sent[0] as object)).toBe(false);
  });

  it("a non-plain EMAIL_FROM is passed through as configured", async () => {
    const m = mailer();
    const from = "Ops <noreply@mail.example.com>";
    const e = { ...(env as object), ...m, EMAIL_FROM: from } as never;
    await sendEmail(
      e,
      "u-rt3",
      "c@x.com",
      () => ({ subject: "s", text: "t", html: "h" }),
      {
        kind: "invite",
        instance: null,
      },
    );
    expect(m.sent[0]?.from).toBe(from);
  });
});
