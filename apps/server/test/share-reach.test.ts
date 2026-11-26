// Review item 37: a share always applies, but when the recipient can't sign
// in on this install (an in-domain non-member on an invite-only install),
// ShareResult.recipient says so and the share email doesn't promise a
// sign-in that can't work.
import { env } from "cloudflare:workers";
import { R, ShareResultSchema, ShareSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authConfig } from "../src/auth/config.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { admit } from "../src/services/identity.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();

/** A hosted install (invite-only, Google through the broker, codes). */
const HOSTED: Partial<Env> = {
  HOSTED: "1",
  // No BILLING gate: the provisioned TIER is the plan (none: free, solo).
  TIER: "business",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
};

async function setup(make: (o: Partial<Env>) => Env, over: Partial<Env>) {
  const m = mailer();
  const e = make({ ...m.env, ...over });
  const o = await login(uniq("own", "a.com"), "member");
  const member = await getUser(env, o.userId);
  if (!member) throw new Error("no user");
  const { id } = await publish(
    env,
    member,
    { title: "Plan", format: "markdown", content: "x" } as never,
    null,
    undefined,
    "create",
  );
  const share = async (email: string, role = "viewer") => {
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.shares(id)}`, {
        method: "PUT",
        headers: {
          cookie: o.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, role }),
      }),
      e,
    );
    expect(r.status).toBe(200);
    return ShareResultSchema.parse(await r.json());
  };
  const list = async (db?: D1Database) => {
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.shares(id)}`, {
        headers: { cookie: o.cookie },
      }),
      db ? ({ ...e, DB: db } as Env) : e,
    );
    expect(r.status).toBe(200);
    return ShareSchema.array().parse(await r.json());
  };
  return { share, list, sent: m.sent };
}

describe("share recipient reach (review item 37)", () => {
  // #2590: a share admits an in-domain non-member as a guest on Google, so
  // there is no needs_invite and no flag; the email names Google, not a code.
  it("hosted, in-domain non-member: the share admits them as a guest, no flag, the email names Google", async () => {
    const { share, sent } = await setup(direct, HOSTED);
    const email = uniq("in", "a.com");
    const s = await share(email);
    expect(s).toMatchObject({ email, role: "viewer", emailed: true });
    expect(s.recipient).toBeUndefined();
    expect(s.reach).toEqual({ ways: ["google"] });
    const m = sent.find((x) => x.to === email);
    // An address at a login domain gets the normal share email.
    expect(m?.text).toContain("You'll log in with your Google account.");
    expect(m?.text).not.toContain("can't log in");
    expect(m?.text).not.toContain("invite you");
    for (const part of [m?.text, m?.html])
      expect(part).not.toContain("one-time code");
  });

  it("hosted, in-domain member: no flag", async () => {
    const { share } = await setup(direct, HOSTED);
    const email = uniq("mem", "a.com");
    await login(email, "member");
    expect((await share(email)).recipient).toBeUndefined();
  });

  it("hosted, outside the domain: a guest with codes, no flag, the email offers a code", async () => {
    const { share, sent } = await setup(direct, HOSTED);
    const email = uniq("g", "out.com");
    const s = await share(email);
    expect(s.recipient).toBeUndefined();
    expect(sent.find((x) => x.to === email)?.text).toContain(
      "Open it with a one-time code.",
    );
  });

  /** Design's copy for outside_domains and no_sign_in_method (#799). */
  const NO_ADDRESS =
    /This address can't log in to .+\. Ask .+ to share it with an address that can\./;

  // #2590: Google alone outside the domains works only for a Workspace
  // account (a consumer account waits for the code step), so it is not a
  // certain way: the sharer is warned (workspace_only), and the email still
  // names Google.
  it("Google only, outside the domain: workspace_only warning, the email names Google", async () => {
    const { share, sent } = await setup(direct, {
      ...HOSTED,
      AUTH_PROVIDERS: "google",
    });
    const email = uniq("g", "out.com");
    const s = await share(email);
    expect(s.recipient).toEqual({
      canSignIn: false,
      reason: "workspace_only",
    });
    expect(s.reach).toEqual({ ways: ["google_workspace"] });
    const m = sent.find((x) => x.to === email);
    expect(m?.text).toContain(`Open it with your Google account (${email}).`);
    expect(m?.text).not.toContain("invite you");
  });

  it("Google only, outside the domain, a Gmail address: a certain way, no flag", async () => {
    const { share } = await setup(direct, {
      ...HOSTED,
      AUTH_PROVIDERS: "google",
    });
    const s = await share(uniq("g", "gmail.com"));
    expect(s.recipient).toBeUndefined();
    expect(s.reach).toEqual({ ways: ["google"] });
  });

  it("Google only, no domains: a non-Gmail address is workspace_only, not outside_domains", async () => {
    const { share } = await setup(direct, {
      ...HOSTED,
      AUTH_PROVIDERS: "google",
      AUTH_DOMAINS: "",
    });
    const email = uniq("g", "out.com");
    const r = (await share(email)).recipient;
    expect(r).toEqual({ canSignIn: false, reason: "workspace_only" });
  });

  // #3184: an invited row signs in by code at its exact address, so an
  // invite now helps here.
  it("email only, domain codes off, in-domain: needs_invite, and the email says so", async () => {
    const { share, sent } = await setup(direct, {
      AUTH_PROVIDERS: "email",
      AUTH_DOMAIN_JOIN: "invite",
    });
    const email = uniq("in", "a.com");
    expect((await share(email)).recipient).toEqual({
      canSignIn: false,
      reason: "needs_invite",
    });
    const m = sent.find((x) => x.to === email);
    expect(m?.text).toContain("Ask an admin there to invite you");
    expect(m?.text).not.toContain("one-time code");
  });

  // A no-row recipient whom only Google might admit (outside AUTH_DOMAINS,
  // domain join on): the email names Google rather than saying they can't
  // sign in. #2590: it is not a certain way, so the sharer gets the
  // workspace_only warning (it used to be unflagged, #799).
  it("only Google might admit a no-row recipient: workspace_only, and the email names Google", async () => {
    const { share, sent } = await setup(direct, {
      ...HOSTED,
      AUTH_PROVIDERS: "google",
    });
    const email = uniq("sec", "secondary.com");
    expect((await share(email)).recipient).toEqual({
      canSignIn: false,
      reason: "workspace_only",
    });
    const m = sent.find((x) => x.to === email);
    expect(m?.text).toContain(`Open it with your Google account (${email}).`);
    expect(m?.text).not.toContain("can't log in");
  });

  it("self-hosted direct with domain join: in-domain non-member logs in with Google, no flag", async () => {
    const { share, sent } = await setup(direct, {});
    const email = uniq("in", "a.com");
    expect((await share(email)).recipient).toBeUndefined();
    expect(sent.find((x) => x.to === email)?.text).toContain(
      "You'll log in with your Google account.",
    );
  });

  it("Access-only (self-host default): no flag", async () => {
    const { share } = await setup((o) => ({ ...env, ...o }) as Env, {});
    expect(
      (await share(uniq("acc", "anywhere.com"))).recipient,
    ).toBeUndefined();
  });
});

/** The email names exactly `methods` (#799: signInMethods and the email agree). */
function namesExactly(text: string | undefined, methods: readonly string[]) {
  const PHRASE: Record<string, string> = {
    google: "your Google account",
    access: "your organization's single sign-on",
    email: "a one-time code.",
  };
  for (const [m, phrase] of Object.entries(PHRASE))
    expect(text ?? "", m).toSatisfy(
      (t: string) => t.includes(phrase) === methods.includes(m),
    );
  expect(text ?? "").toSatisfy(
    (t: string) => t.includes("can't log in") === (methods.length === 0),
  );
}

describe("the share email names the level the recipient will have", () => {
  it("outside the domains, an Editor share reads Commenter: they'll be a guest (#2590)", async () => {
    const { share, sent } = await setup(direct, HOSTED);
    const email = uniq("g", "out.com");
    await share(email, "editor");
    const m = sent.find((x) => x.to === email);
    // The outside email (#2590) carries no role line; the level is the row's.
    expect(m?.text).not.toContain("Your role");
    expect(m?.html).not.toContain("Editor");
  });

  it("Access-only (self-host, no login domains): every address is outside, so no role line", async () => {
    const { share, sent } = await setup((o) => ({ ...env, ...o }) as Env, {});
    const email = uniq("acc", "a.com");
    await share(email, "editor");
    expect(sent.find((x) => x.to === email)?.text).not.toContain("Your role");
  });

  it("in a verified domain, an Editor share stays Editor: they'll be a member", async () => {
    const { share, sent } = await setup(direct, HOSTED);
    const email = uniq("in", "a.com");
    await share(email, "editor");
    // The normal share email keeps its role line (an outside one has none).
    expect(sent.find((x) => x.to === email)?.text).toContain(
      "Your role: Editor",
    );
  });
});

describe("guest on a share row, and the email, from one rule", () => {
  const access = (o: Partial<Env>) => ({ ...env, ...o }) as Env;
  const CODES = { AUTH_PROVIDERS: "email", EMAIL_CODE_DOMAIN: "on" };
  const IN = "a.com";
  const OUT = "out.com";
  it.each<[string, (o: Partial<Env>) => Env, Partial<Env>, string, boolean]>([
    ["Access-only", access, {}, IN, true],
    [
      "Google only, join member, in-domain",
      direct,
      { AUTH_PROVIDERS: "google" },
      IN,
      false,
    ],
    [
      "Google only, invite, in-domain",
      direct,
      { AUTH_PROVIDERS: "google", AUTH_DOMAIN_JOIN: "invite" },
      IN,
      false,
    ],
    [
      "Google only, invite, outside",
      direct,
      { AUTH_PROVIDERS: "google", AUTH_DOMAIN_JOIN: "invite" },
      OUT,
      false,
    ],
    [
      "Google only, join member, outside",
      direct,
      { AUTH_PROVIDERS: "google" },
      OUT,
      false,
    ],
    ["codes, join member, in-domain", direct, CODES, IN, false],
    [
      "codes, invite, in-domain",
      direct,
      { ...CODES, AUTH_DOMAIN_JOIN: "invite" },
      IN,
      false,
    ],
    [
      "codes, domain codes off, in-domain",
      direct,
      { AUTH_PROVIDERS: "email" },
      IN,
      false,
    ],
    ["codes, outside", direct, CODES, OUT, true],
    ["Google and codes, outside", direct, {}, OUT, true],
    [
      "Access and Google, in-domain: Access would make a guest",
      direct,
      { AUTH_PROVIDERS: "access,google" },
      IN,
      true,
    ],
    ["Google and codes, invite, in-domain", direct, HOSTED, IN, false],
    ["hosted, outside", direct, HOSTED, OUT, true],
  ])("%s", async (name, make, over, domain, guest) => {
    const { share, list, sent } = await setup(make, over);
    const email = uniq("r", domain);
    await share(email, "editor");
    const row = (await list()).find((r) => r.email === email);
    // An outsider is stored as commenter, never editor (#2590).
    expect(row?.role).toBe(guest ? "commenter" : "editor");
    expect(row?.guest === true).toBe(guest);
    // An outside address (outside the login domains, or on an install with
    // none) gets the outside email, which has no role line (#2590); an
    // address at a login domain gets the normal share email, with its role.
    const text = sent.find((x) => x.to === email)?.text ?? "";
    const outsideMail = text.includes(
      "shared a page with you on Open Artifacts",
    );
    // An outside address gets the outside email on every install; an address
    // at a login domain gets the normal one. (An install with no login
    // domains, Access-only, has every address outside.)
    expect(outsideMail).toBe(domain === OUT || name === "Access-only");
    if (outsideMail) expect(text).not.toContain("Your role");
    else expect(text).toContain(`Your role: ${guest ? "Commenter" : "Editor"}`);
  });

  it("once a shared address has a member row, the row's role decides", async () => {
    const e = direct({ AUTH_PROVIDERS: "access,google" });
    const { share, list } = await setup(() => e, {});
    const email = uniq("join", IN);
    await share(email, "editor");
    const row = async () => (await list()).find((r) => r.email === email);
    expect(await row()).toMatchObject({ role: "commenter", guest: true });
    const signedIn = await admit(e, authConfig(e), {
      provider: "google",
      subject: uniq("sub", IN),
      email,
      name: null,
      tenant: IN,
    });
    expect(signedIn).toMatchObject({ ok: true, user: { role: "member" } });
    // Stored as commenter at share time (an outsider is never stored as editor).
    expect(await row()).toMatchObject({ role: "commenter" });
    expect(await row()).not.toHaveProperty("guest");
  });

  it("listing more no-row shares runs no more statements", async () => {
    const { share, list } = await setup(direct, {});
    let n = 0;
    // Counts executions: stmt() caches a prepared statement, so prepare can't.
    const statement = (real: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(real, {
        get(t, k) {
          const v = Reflect.get(t, k);
          if (typeof v !== "function") return v;
          return (...a: unknown[]) => {
            if (k === "bind") return statement(v.apply(t, a));
            if (["first", "all", "run", "raw"].includes(String(k))) n++;
            return v.apply(t, a);
          };
        },
      });
    const counted = new Proxy(env.DB, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          if (k === "batch") n++;
          const out = v.apply(t, a);
          return k === "prepare" ? statement(out) : out;
        };
      },
    });
    const count = async () => {
      n = 0;
      await list(counted);
      return n;
    };
    await share(uniq("n", OUT));
    const one = await count();
    await share(uniq("n", OUT));
    await share(uniq("n", IN));
    expect(one).toBeGreaterThan(0);
    expect(await count()).toBe(one);
  });
});

describe("ShareResult.signInMethods (#799)", () => {
  it.each([
    ["hosted, in-domain non-member", direct, HOSTED, "a.com", ["google"]],
    ["hosted, outside guest", direct, HOSTED, "out.com", ["email"]],
    [
      "Google only, outside",
      direct,
      { ...HOSTED, AUTH_PROVIDERS: "google" },
      "out.com",
      ["google"],
    ],
    [
      "email only, domain codes off, in-domain",
      direct,
      { AUTH_PROVIDERS: "email", AUTH_DOMAIN_JOIN: "invite" },
      "a.com",
      [],
    ],
    [
      "only Google might admit (no row)",
      direct,
      { AUTH_PROVIDERS: "google", AUTH_DOMAIN_JOIN: "member" },
      "secondary.com",
      ["google"],
    ],
    [
      "self-hosted direct, domain join, in-domain",
      direct,
      {},
      "a.com",
      ["google"],
    ],
    [
      "Access only",
      (o: Partial<Env>) => ({ ...env, ...o }) as Env,
      {},
      "any.com",
      ["access"],
    ],
  ] as const)(
    "%s: %j, the list the email names",
    async (_, make, over, domain, want) => {
      const { share, sent } = await setup(make, over as Partial<Env>);
      const email = uniq("r", domain);
      const s = await share(email);
      expect(s.signInMethods).toEqual(want);
      namesExactly(
        sent.find((x) => x.to === email)?.text,
        s.signInMethods ?? [],
      );
    },
  );
});
