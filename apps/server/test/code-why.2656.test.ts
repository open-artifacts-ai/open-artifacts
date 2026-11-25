// #2656: a code that wasn't sent says why (a fixed word, never the address), and
// the refusals before any send leave a line too.
import { env } from "cloudflare:workers";
import { AUTH } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { deliverCode, emailKey } from "../src/auth/codes.js";
import { authConfig } from "../src/auth/config.js";
import type { Env } from "../src/env.js";
import {
  type CodeWhy,
  codeEligibility,
  linkEligibility,
} from "../src/services/identity.js";
import {
  direct,
  mailer,
  seedShare,
  seedUser,
  trial,
  uniq,
} from "./auth-helpers.js";

const app = createApp();
const IP = "203.0.113.77";
afterEach(() => vi.restoreAllMocks());

const why = async (e: Env, email: string) => {
  const r = await codeEligibility(env, authConfig(e), email);
  return r.kind === "none" ? r.why : r.kind;
};
const whyLink = async (email: string) => {
  const r = await linkEligibility(env, email);
  return r.kind === "none" ? r.why : r.kind;
};
const setOutside = (on: boolean) =>
  env.DB.prepare(
    "insert into settings (key, value) values ('outside_sharing', ?) on conflict (key) do update set value = excluded.value",
  )
    .bind(String(on))
    .run();

describe("codeEligibility says why not", () => {
  it.each<[string, () => Promise<[Env, string]>, CodeWhy]>([
    ["not an address", async () => [direct(), "nope"], "bad_address"],
    [
      "a removed row",
      async () => {
        const a = uniq("rm", "x.com");
        await seedUser(a, "guest", { status: "removed" });
        return [direct(), a];
      },
      "row_inactive",
    ],
    [
      "a Google-linked row",
      async () => {
        const a = uniq("lk", "x.com");
        await seedUser(a, "guest", { googleSub: `L-${a}` });
        return [direct(), a];
      },
      "linked",
    ],
    [
      "an expired invite",
      async () => {
        const a = uniq("ex", "a.com");
        const id = await seedUser(a, "member");
        await env.DB.prepare(
          "update users set invited_at = ?, last_seen_at = null where id = ?",
        )
          .bind(Date.now() - 40 * 86_400_000, id)
          .run();
        return [trial(), a];
      },
      "invite_expired",
    ],
    [
      "a login-domain address while domain codes are off",
      async () => [direct(), uniq("dom", "a.com")],
      "domain_codes_off",
    ],
    [
      "a new login-domain address when joining is by invite",
      async () => [
        trial({ AUTH_DOMAIN_JOIN: "invite" }),
        uniq("dom2", "a.com"),
      ],
      "domain_no_join",
    ],
    [
      "an admin row outside the domains",
      async () => {
        const a = uniq("adm", "x.com");
        await seedUser(a, "admin");
        return [direct(), a];
      },
      "not_guest",
    ],
    [
      "a member row outside the domains on an install without Google",
      async () => {
        const a = uniq("mem", "x.com");
        await seedUser(a, "member");
        return [trial(), a];
      },
      "not_guest",
    ],
    [
      "an address nobody shared with",
      async () => [direct(), uniq("nobody", "x.com")],
      "no_share",
    ],
  ])("%s", async (_n, setup, expected) => {
    const [e, email] = await setup();
    expect(await why(e, email)).toBe(expected);
  });

  it("the owner's outside-sharing switch off: outsider_off, for a share and for a guest row; on again, eligible", async () => {
    const shared = uniq("sh", "x.com");
    await seedShare(shared);
    const guest = uniq("gu", "x.com");
    const gid = await seedUser(guest, "guest");
    await seedShare(guest);
    await env.DB.prepare("update shares set email = ? where email = ?")
      .bind(guest, guest)
      .run();
    void gid;
    try {
      await setOutside(false);
      expect(await why(direct(), shared)).toBe("outsider_off");
      expect(await why(direct(), guest)).toBe("outsider_off");
      await setOutside(true);
      expect(await why(direct(), shared)).toBe("guest");
    } finally {
      await setOutside(true);
    }
  });
});

describe("linkEligibility says why not", () => {
  it("each branch", async () => {
    expect(await whyLink("nope")).toBe("bad_address");
    expect(await whyLink(uniq("none", "x.com"))).toBe("no_share");
    const rm = uniq("rm", "x.com");
    await seedUser(rm, "guest", { status: "removed" });
    expect(await whyLink(rm)).toBe("row_inactive");
    const lk = uniq("lk", "x.com");
    await seedUser(lk, "guest", { googleSub: `L-${lk}` });
    expect(await whyLink(lk)).toBe("linked");
    const ex = uniq("ex", "x.com");
    const id = await seedUser(ex, "member");
    await env.DB.prepare(
      "update users set invited_at = ?, last_seen_at = null where id = ?",
    )
      .bind(Date.now() - 40 * 86_400_000, id)
      .run();
    expect(await whyLink(ex)).toBe("invite_expired");
    const ug = uniq("ug", "x.com");
    await seedUser(ug, "guest");
    expect(await whyLink(ug)).toBe("no_share");
    const sh = uniq("sh", "x.com");
    await seedShare(sh);
    try {
      await setOutside(false);
      expect(await whyLink(sh)).toBe("outsider_off");
    } finally {
      await setOutside(true);
    }
    expect(await whyLink(sh)).toBe("guest");
  });
});

/** Every console line while `fn` runs, as parsed JSON where it parses. */
async function logs(fn: () => Promise<unknown>) {
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    }),
  );
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const parsed = lines.flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  return { text: lines.join("\n"), parsed };
}

describe("the log lines", () => {
  it("code_send for an ineligible address carries the why, and never the address or its key", async () => {
    const e = { ...direct(), ...mailer().env } as Env;
    const email = uniq("nobody", "x.com");
    const ek = await emailKey(e, email);
    const out = await logs(() =>
      deliverCode(e, authConfig(e), email, ek, "rid", IP),
    );
    const sends = out.parsed.filter((l) => l.evt === "code_send");
    expect(sends).toEqual([
      { evt: "code_send", outcome: "ineligible", why: "no_share" },
    ]);
    expect(out.text).not.toContain(email);
    expect(out.text).not.toContain(ek);
    // A sent code has no why.
    const shared = uniq("ok", "x.com");
    await seedShare(shared);
    const ok = await logs(async () =>
      deliverCode(
        e,
        authConfig(e),
        shared,
        await emailKey(e, shared),
        "rid2",
        IP,
      ),
    );
    expect(ok.parsed.filter((l) => l.evt === "code_send")).toEqual([
      { evt: "code_send", outcome: "sent" },
    ]);
  });

  const post = (e: Env, email: string, extra: object = {}, ip = IP) =>
    app.fetch(
      new Request(`http://app.localhost${AUTH.codeRequest}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oa-request": "1",
          "sec-fetch-site": "same-origin",
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify({ email, next: "/a/x", ...extra }),
      }),
      e as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
  const refused = async (
    fn: () => Response | Promise<Response>,
    email: string,
  ) => {
    const out = await logs(async () => {
      await fn();
    });
    expect(out.text).not.toContain(email);
    return out.parsed.filter((l) => l.evt === "code_request_refused");
  };

  it("Turnstile missing, failed and off on hosted each leave one code_request_refused line", async () => {
    const a = uniq("t", "x.com");
    expect(await refused(() => post(trial(), a), a)).toEqual([
      { evt: "code_request_refused", reason: "turnstile_required" },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: false }),
    );
    expect(
      await refused(() => post(trial(), a, { turnstileToken: "bad" }), a),
    ).toEqual([{ evt: "code_request_refused", reason: "turnstile_failed" }]);
    vi.restoreAllMocks();
    expect(
      await refused(
        () =>
          post(
            direct({
              HOSTED: "1",
              TURNSTILE_SITE_KEY: undefined,
              TURNSTILE_SECRET: undefined,
            }),
            a,
          ),
        a,
      ),
    ).toEqual([
      { evt: "code_request_refused", reason: "turnstile_off_hosted" },
    ]);
  });

  it("RL_AUTH denial, an unbound limiter and the per-address slot each leave one line", async () => {
    const a = uniq("rl", "x.com");
    const deny = {
      limit: async () => ({ success: false }),
    } as unknown as RateLimit;
    expect(await refused(() => post(direct({ RL_AUTH: deny }), a), a)).toEqual([
      { evt: "code_request_refused", reason: "ip_limit" },
    ]);
    expect(
      await refused(
        () =>
          post(direct({ ENVIRONMENT: "production", RL_AUTH: undefined }), a),
        a,
      ),
    ).toEqual([{ evt: "code_request_refused", reason: "limiter_unbound" }]);
    // The fourth request from one network for one address within 10 minutes.
    const b = uniq("slot", "x.com");
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 3; i++) await post(direct(), b, {}, ip);
    expect(await refused(() => post(direct(), b, {}, ip), b)).toEqual([
      { evt: "code_request_refused", reason: "request_slot_email" },
    ]);
  });
});
