import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { deliverCode, emailKey } from "../src/auth/codes.js";
import { authConfig } from "../src/auth/config.js";
import { alertOwners } from "../src/directory/alert.js";
import {
  cleanInstanceName,
  type EmailKind,
  FROM_NAME_MAX,
  fromName,
  SETTINGS_READ_MS,
  sendEmail,
} from "../src/email/send.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { direct, seedUser, uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";

// The From display name: "<install> via Open Artifacts" on the shared sender.

const FROM = "noreply@mail.example.test";
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

type Msg = { from: unknown; to: string; [k: string]: unknown };
function mailer() {
  const sent: Msg[] = [];
  return {
    sent,
    env: {
      EMAIL_FROM: FROM,
      EMAIL: {
        async send(m: Msg) {
          sent.push(m);
          return { messageId: "m1" };
        },
      } as unknown as SendEmail,
    },
  };
}
const content = () => ({ subject: "s", text: "t", html: "h" });
const setName = (v: string) =>
  env.DB.prepare(
    "insert or replace into settings (key, value) values ('name', ?)",
  )
    .bind(v)
    .run();
const clearName = () =>
  env.DB.prepare("delete from settings where key = 'name'").run();

/** Decodes RFC 2047 B words back to text (test-side check only). */
const decode = (s: string) =>
  s
    .split(" ")
    .map((w) => {
      const m = w.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
      if (!m) return w;
      const bin = atob(m[1] as string);
      return new TextDecoder().decode(
        Uint8Array.from(bin, (c) => c.charCodeAt(0)),
      );
    })
    .join("");

beforeEach(async () => {
  await env.DB.prepare(
    "delete from counters where key like 'email:%' or key like 'code:%'",
  ).run();
});
afterEach(clearName);

describe("cleanInstanceName", () => {
  it("strips quotes, backslash, angle brackets, @ and other specials", () => {
    expect(cleanInstanceName('"Acme" \\ <Co> @ (x), [y]; z: a.b')).toBe(
      "Acme Co x y z ab",
    );
  });

  it("strips CR/LF so no header can be injected", () => {
    const c = cleanInstanceName("Acme\r\nBcc: x@evil.test");
    expect(c).not.toMatch(/[\r\n]/);
    expect(c).toBe("Acme Bcc xeviltest");
  });

  it("strips every control, separator and bidi character", () => {
    const bad = [
      "\u0000",
      "\u001f",
      "\u007f",
      "\u0085",
      "\u009f",
      " ",
      " ",
      "‪",
      "‫",
      "‬",
      "‭",
      "‮",
      "⁦",
      "⁧",
      "⁨",
      "⁩",
      "‎",
      "‏",
      "\ud800",
    ];
    // Line breaks become a space; everything else goes.
    expect(cleanInstanceName(`A${bad.join("")}B`)).toBe("A B");
    for (const ch of bad)
      expect(cleanInstanceName(`A${ch}B`)).toMatch(/^A ?B$/);
    expect(cleanInstanceName("Acme ‮gnp.exe")).toBe("Acme gnpexe");
  });

  it("collapses whitespace and trims", () => {
    expect(cleanInstanceName("  Acme \t   Labs  ")).toBe("Acme Labs");
  });

  it("keeps emoji intact, including ZWJ sequences", () => {
    expect(cleanInstanceName("Acme 🚀 👩‍💻")).toBe("Acme 🚀 👩‍💻");
  });

  it(`caps at ${FROM_NAME_MAX} code points without splitting a surrogate pair`, () => {
    const long = "😀".repeat(100);
    const c = cleanInstanceName(long);
    expect(Array.from(c)).toHaveLength(FROM_NAME_MAX);
    expect(c).toBe("😀".repeat(FROM_NAME_MAX));
    expect(/\p{Cs}/u.test(c)).toBe(false);
    // Odd offset: an ASCII prefix pushes the cap mid-way through pairs.
    const mixed = cleanInstanceName(`a${"😀".repeat(100)}`);
    expect(Array.from(mixed)).toHaveLength(FROM_NAME_MAX);
    expect(/\p{Cs}/u.test(mixed)).toBe(false);
    expect(cleanInstanceName("x".repeat(150))).toBe("x".repeat(FROM_NAME_MAX));
  });

  it("empty or all-stripped is empty", () => {
    expect(cleanInstanceName("")).toBe("");
    expect(cleanInstanceName(null)).toBe("");
    expect(cleanInstanceName(undefined)).toBe("");
    expect(cleanInstanceName(' "<>@\\\r\n‮ ')).toBe("");
  });

  it("NFKC turns fullwidth lookalikes into ASCII before the specials strip", () => {
    const c = cleanInstanceName("Google ＜security＠google．com＞");
    expect(c).not.toMatch(/[<>@.＜＞＠．]/);
    expect(c).toBe("Google securitygooglecom");
  });

  it("invisible padding is stripped", () => {
    for (const pad of ["ㅤ", "​", "⠀", "ᅟ", "ﾠ"])
      expect(fromName(`PayPal${pad.repeat(56)}`)).toBe(
        "PayPal via Open Artifacts",
      );
  });

  it("soft hyphen, word joiner and tag characters are stripped", () => {
    expect(cleanInstanceName("Ac­me⁠ \u{E0041}\u{E007F}Labs")).toBe("Acme Labs");
  });

  it("space separators become one space", () => {
    expect(cleanInstanceName("Acme　  Labs")).toBe("Acme Labs");
  });

  it("a ZWJ emoji family survives", () => {
    const fam = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    expect(cleanInstanceName(`Acme ${fam}`)).toBe(`Acme ${fam}`);
  });
});

describe("fromName", () => {
  it("is '<install> via Open Artifacts'", () => {
    expect(fromName("Acme")).toBe("Acme via Open Artifacts");
    expect(fromName('"Acme" <Co>')).toBe("Acme Co via Open Artifacts");
  });

  it("falls back to the product name when unset, empty or all stripped", () => {
    for (const v of [
      null,
      undefined,
      "",
      "   ",
      '"<>"',
      "\r\n",
      "Open Artifacts",
    ])
      expect(fromName(v)).toBe("Open Artifacts");
  });

  it("a name that claims the product falls back to the product name", () => {
    for (const v of [
      "Open Artifacts Security",
      "OPENARTIFACTS",
      "Team Open  Artifacts",
      "Ｏpen Ａrtifacts",
      "Open​Artifacts",
    ])
      expect(fromName(v)).toBe("Open Artifacts");
    expect(fromName("Open Art")).toBe("Open Art via Open Artifacts");
  });

  it("RFC 2047-encodes non-ASCII in words of at most 75 chars", () => {
    const n = fromName("Acme 🚀");
    expect(n).toMatch(
      /^(=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)( =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)*$/,
    );
    expect(decode(n)).toBe("Acme 🚀 via Open Artifacts");
    const long = fromName("😀".repeat(100));
    for (const w of long.split(" ")) expect(w.length).toBeLessThanOrEqual(75);
    expect(decode(long)).toBe(
      `${"😀".repeat(FROM_NAME_MAX)} via Open Artifacts`,
    );
  });

  it("encodes an ASCII name that looks like an encoded word", () => {
    const n = fromName("=?UTF-8?B?QUJD?=");
    expect(n.startsWith("=?UTF-8?B?")).toBe(true);
    expect(decode(n)).toBe("=?UTF-8?B?QUJD?= via Open Artifacts");
  });
});

describe("sendEmail From", () => {
  const e = (m: ReturnType<typeof mailer>, over: object = {}) =>
    ({ ...(env as object), ...m.env, ...over }) as unknown as Env;

  it("the binding receives exactly the cleaned name on the plain sender", async () => {
    const m = mailer();
    await sendEmail(e(m), null, "a@x.test", content, {
      kind: "invite",
      instance: "Acme\r\nBcc: x@evil.test",
    });
    expect(m.sent).toEqual([
      {
        from: { email: FROM, name: "Acme Bcc xeviltest via Open Artifacts" },
        to: "a@x.test",
        subject: "s",
        text: "t",
        html: "h",
      },
    ]);
    const json = JSON.stringify(m.sent);
    expect(json).not.toMatch(/\\r|\\n/);
    expect(
      Object.keys(m.sent[0] as object).map((k) => k.toLowerCase()),
    ).not.toContain("bcc");
  });

  it("a bidi override and quotes never reach the binding", async () => {
    const m = mailer();
    await sendEmail(e(m), null, "b@x.test", content, {
      kind: "share",
      instance: '"Acme‮" \\ Labs',
    });
    expect((m.sent[0] as Msg).from).toEqual({
      email: FROM,
      name: "Acme Labs via Open Artifacts",
    });
  });

  it("an emoji name reaches the binding RFC 2047-encoded", async () => {
    const m = mailer();
    await sendEmail(e(m), null, "c@x.test", content, {
      kind: "code",
      caps: [],
      instance: "Acme 🚀",
    });
    const from = (m.sent[0] as Msg).from as { email: string; name: string };
    expect(from.email).toBe(FROM);
    expect(from.name).toMatch(/^[\x20-\x7e]+$/);
    expect(decode(from.name)).toBe("Acme 🚀 via Open Artifacts");
  });

  it("empty and all-stripped names fall back to the product name", async () => {
    const m = mailer();
    for (const instance of ["", ' "<>@ '])
      await sendEmail(e(m), null, uniq("d", "x.test"), content, {
        kind: "invite",
        instance,
      });
    expect(m.sent.map((s) => s.from)).toEqual([
      { email: FROM, name: "Open Artifacts" },
      { email: FROM, name: "Open Artifacts" },
    ]);
  });

  /**
   * env.DB with the settings read counted, and made to fail or hang; every
   * other statement (the counters) goes to the real D1.
   */
  function settingsDb(mode: "ok" | "fail" | "hang") {
    const reads = { n: 0 };
    const real = env.DB;
    const DB = new Proxy(real, {
      get(t, p) {
        if (p === "prepare")
          return (sql: string) => {
            if (!sql.includes("from settings")) return t.prepare(sql);
            const s = t.prepare(sql);
            return {
              all: () => {
                reads.n++;
                if (mode === "fail")
                  return Promise.reject(new Error("D1_ERROR"));
                if (mode === "hang") return new Promise(() => {});
                return s.all();
              },
              bind() {
                return this;
              },
            };
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { DB, reads };
  }

  it("without a passed name, reads the settings name", async () => {
    await setName("Globex");
    const m = mailer();
    const { DB, reads } = settingsDb("ok");
    await sendEmail(e(m, { DB }), null, "f@x.test", content, {
      kind: "invite",
      instance: undefined,
    });
    expect(reads.n).toBe(1);
    expect((m.sent[0] as Msg).from).toEqual({
      email: FROM,
      name: "Globex via Open Artifacts",
    });
  });

  it("a passed name means no settings read in sendEmail", async () => {
    await setName("Globex");
    const m = mailer();
    const { DB, reads } = settingsDb("ok");
    await sendEmail(e(m, { DB }), null, "f2@x.test", content, {
      kind: "invite",
      instance: "Acme",
    });
    expect(reads.n).toBe(0);
    expect((m.sent[0] as Msg).from).toEqual({
      email: FROM,
      name: "Acme via Open Artifacts",
    });
  });

  it("a settings read failure falls back to the product name and still sends", async () => {
    await setName("Globex");
    const m = mailer();
    const { DB } = settingsDb("fail");
    const ok = await sendEmail(e(m, { DB }), null, "g@x.test", content, {
      kind: "directory",
      instance: undefined,
    });
    expect(ok).toBe(true);
    expect((m.sent[0] as Msg).from).toEqual({
      email: FROM,
      name: "Open Artifacts",
    });
  });

  it(`a hanging settings read gives up after ${SETTINGS_READ_MS} ms and sends with the product name`, async () => {
    await setName("Globex");
    const m = mailer();
    const { DB, reads } = settingsDb("hang");
    const t0 = Date.now();
    const ok = await sendEmail(e(m, { DB }), null, "g2@x.test", content, {
      kind: "directory",
      instance: undefined,
    });
    expect(ok).toBe(true);
    expect(reads.n).toBe(1);
    expect(Date.now() - t0).toBeLessThan(SETTINGS_READ_MS + 1500);
    expect((m.sent[0] as Msg).from).toEqual({
      email: FROM,
      name: "Open Artifacts",
    });
  });

  it("every EmailKind gets the install name", async () => {
    const kinds: EmailKind[] = [
      "invite",
      "share",
      "code",
      "space",
      "directory",
    ];
    const m = mailer();
    for (const kind of kinds)
      await sendEmail(e(m), null, uniq(kind, "x.test"), content, {
        kind,
        caps: [],
        instance: "Acme",
      });
    expect(m.sent.map((s) => s.from)).toEqual(
      kinds.map(() => ({ email: FROM, name: "Acme via Open Artifacts" })),
    );
  });

  it("a non-plain EMAIL_FROM is passed through as configured", async () => {
    const m = mailer();
    const from = "Ops <noreply@mail.example.test>";
    await sendEmail(e(m, { EMAIL_FROM: from }), null, "h@x.test", content, {
      kind: "invite",
      instance: "Acme",
    });
    expect((m.sent[0] as Msg).from).toBe(from);
  });
});

describe("every caller sends the install name", () => {
  const ACME = { email: FROM, name: "Acme via Open Artifacts" };
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

  it("invite and share", async () => {
    await setName("Acme");
    const o = await login(uniq("own", "x.test"), "owner");
    const m = mailer();
    expect(
      (
        await call(m.env, R.members, o.cookie, "POST", {
          email: uniq("inv", "x.test"),
          role: "member",
        })
      ).status,
    ).toBe(201);
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
    await call(m.env, R.shares(id), o.cookie, "PUT", {
      email: uniq("shr", "x.test"),
      role: "viewer",
    });
    expect(m.sent.map((s) => s.from)).toEqual([ACME, ACME]);
  });

  it("sign-in code", async () => {
    await setName("Acme");
    const addr = uniq("g", "x.com");
    await seedUser(addr, "guest");
    const m = mailer();
    const e = { ...direct(), ...m.env } as Env;
    const ek = await emailKey(e, addr);
    await deliverCode(e, authConfig(e), addr, ek, "rid-from", "203.0.113.9");
    expect(m.sent.map((s) => s.from)).toEqual([ACME]);
  });

  it("directory alert", async () => {
    await setName("Acme");
    const m = mailer();
    await alertOwners(
      { ...(env as object), ...m.env } as unknown as Env,
      "unhealthy",
      [uniq("o", "x.test")],
    );
    expect(m.sent.map((s) => s.from)).toEqual([ACME]);
  });
});
