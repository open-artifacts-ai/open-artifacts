import { env } from "cloudflare:workers";
import {
  newId,
  type Passkey,
  type PasskeyChallenge,
  type PasskeySettings,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { passkeyRemovedEmail } from "../src/email/templates.js";
import type { Env } from "../src/env.js";
import { appOrigin } from "../src/http/errors.js";
import { confirmFor } from "../src/services/passkeys.js";
import { api, errOf, login } from "./helpers.js";
import { FakeAuthenticator } from "./passkey-helper.js";

const app = createApp();
const E = env as unknown as Env;
const origin = appOrigin(E);
const rpId = E.APP_HOST.split(":")[0] as string;
const DAY = 24 * 3600 * 1000;
const tag = newId().slice(0, 6).toLowerCase();

type U = { cookie: string; fresh: string; userId: string; pat: string };
async function mk(prefix: string): Promise<U> {
  const l = await login(`${prefix}-${tag}@x.com`, "member");
  const row = await E.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(l.userId)
    .first<{ e: number }>();
  const now = Date.now();
  const fresh = `${sessionCookieName(E)}=${await signSession(E, l.userId, now, {
    provider: "access",
    epoch: row?.e ?? 0,
    authAt: now,
  })}`;
  return {
    ...l,
    fresh,
    pat: (await createPat(E, l.userId, "agent")).token,
  };
}

const json = <T>(r: Response) => r.json() as Promise<T>;

/** Registers a passkey through the routes; `age` back-dates it past the cooling. */
async function addPasskey(
  u: U,
  auth = u.fresh,
  age = true,
): Promise<{ a: FakeAuthenticator; passkey: Passkey }> {
  const a = await FakeAuthenticator.create();
  const begin = await api(app, R.passkeyRegisterBegin, auth, {
    method: "POST",
  });
  expect(begin.status).toBe(200);
  const { options } = await json<PasskeyChallenge>(begin);
  const fin = await api(app, R.passkeyRegisterFinish, auth, {
    method: "POST",
    body: {
      credential: await a.attest({
        challenge: options.challenge as string,
        origin,
        rpId,
      }),
      label: "Laptop",
    },
  });
  expect(fin.status).toBe(201);
  const passkey = await json<Passkey>(fin);
  if (age)
    await E.DB.prepare("update passkeys set created_at = ? where id = ?")
      .bind(Date.now() - 2 * DAY, passkey.id)
      .run();
  return { a, passkey };
}

const get = async (u: U, body: object, path: string) =>
  api(app, path, u.cookie, { method: "POST", body });

/** An assertion for the options a challenge route returned. */
const assertFor = async (
  a: FakeAuthenticator,
  c: PasskeyChallenge,
  extra = {},
) =>
  a.assert({
    challenge: c.options.challenge as string,
    origin,
    rpId,
    ...extra,
  });

const ALL_ON = {
  actions: {
    merge: true,
    deploy: true,
    delete: true,
    share: true,
    public: true,
    command: true,
  },
  everyPick: false,
};
const off = (...names: string[]) => ({
  ...ALL_ON,
  actions: {
    ...ALL_ON.actions,
    ...Object.fromEntries(names.map((n) => [n, false])),
  },
});

const auditOf = async (userId: string, action: string) =>
  (
    await E.DB.prepare(
      "select detail from audit_events where actor_id = ? and action = ? order by at desc",
    )
      .bind(userId, action)
      .all<{ detail: string }>()
  ).results.map((r) => JSON.parse(r.detail) as Record<string, unknown>);

describe("registering a passkey", () => {
  let u: U;
  beforeAll(async () => {
    u = await mk("reg");
  });

  it("needs a fresh re-auth, in a browser session", async () => {
    const plain = await api(app, R.passkeyRegisterBegin, u.cookie, {
      method: "POST",
    });
    expect(plain.status).toBe(401);
    const e = await errOf(plain);
    expect(e.code).toBe("reauth_required");
    expect((e.details as { reauthUrl: string }).reauthUrl).toContain("next=");
    const tok = await api(app, R.passkeyRegisterBegin, u.pat, {
      method: "POST",
    });
    expect(tok.status).toBe(403);
    expect((await api(app, R.passkeys, u.pat)).status).toBe(403);
  });

  it("stores it cooling, audits it, and lists it", async () => {
    const { passkey } = await addPasskey(u, u.fresh, false);
    expect(passkey.usable).toBe(false);
    expect(Date.parse(passkey.usableAt) - Date.parse(passkey.createdAt)).toBe(
      DAY,
    );
    const list = await json<Passkey[]>(await api(app, R.passkeys, u.cookie));
    expect(list.map((p) => p.id)).toContain(passkey.id);
    expect((await auditOf(u.userId, "passkey.add")).length).toBe(1);
  });

  it("refuses a registration with a replayed or missing challenge", async () => {
    const a = await FakeAuthenticator.create();
    const { options } = await json<PasskeyChallenge>(
      await api(app, R.passkeyRegisterBegin, u.fresh, { method: "POST" }),
    );
    const credential = await a.attest({
      challenge: options.challenge as string,
      origin,
      rpId,
    });
    const body = { credential };
    expect(
      (
        await api(app, R.passkeyRegisterFinish, u.fresh, {
          method: "POST",
          body,
        })
      ).status,
    ).toBe(201);
    const again = await api(app, R.passkeyRegisterFinish, u.fresh, {
      method: "POST",
      body,
    });
    expect(again.status).toBe(410);
    expect((await errOf(again)).code).toBe("challenge_expired");
  });

  it("refuses an attestation for another origin", async () => {
    const a = await FakeAuthenticator.create();
    const { options } = await json<PasskeyChallenge>(
      await api(app, R.passkeyRegisterBegin, u.fresh, { method: "POST" }),
    );
    const credential = await a.attest({
      challenge: options.challenge as string,
      origin: "https://evil.test",
      rpId,
    });
    const r = await api(app, R.passkeyRegisterFinish, u.fresh, {
      method: "POST",
      body: { credential },
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("passkey_failed");
  });
});

describe("removing a passkey", () => {
  it("needs a fresh re-auth or an assertion; only your own", async () => {
    const u = await mk("rm");
    const other = await mk("rm-other");
    const { a, passkey } = await addPasskey(u);
    expect(
      (await api(app, R.passkey(passkey.id), u.cookie, { method: "DELETE" }))
        .status,
    ).toBe(401);
    expect(
      (await api(app, R.passkey(passkey.id), other.fresh, { method: "DELETE" }))
        .status,
    ).toBe(404);
    // With an assertion bound to this removal.
    const c = await json<PasskeyChallenge>(
      await get(u, {}, R.passkeyChallenge(passkey.id)),
    );
    const assertion = await assertFor(a, c);
    const done = await api(app, R.passkey(passkey.id), u.cookie, {
      method: "DELETE",
      body: { assertion },
    });
    expect(done.status).toBe(204);
    expect(
      (await auditOf(u.userId, "passkey.remove"))[0]?.passkeyVerified,
    ).toBe(true);
    expect(await json<Passkey[]>(await api(app, R.passkeys, u.cookie))).toEqual(
      [],
    );
  });

  it("a re-auth alone only schedules it: 24 h out, still counting, cancellable", async () => {
    const u = await mk("rm2");
    const { passkey } = await addPasskey(u);
    const r = await api(app, R.passkey(passkey.id), u.fresh, {
      method: "DELETE",
    });
    expect(r.status).toBe(202);
    const { removesAt } = await json<{ removesAt: string }>(r);
    expect(Date.parse(removesAt) - Date.now()).toBeGreaterThan(DAY - 60_000);
    expect((await auditOf(u.userId, "passkey.remove"))[0]).toMatchObject({
      pending: true,
      passkeyVerified: false,
    });
    // It is still there, marked, and still marks new asks.
    const list = await json<Passkey[]>(await api(app, R.passkeys, u.cookie));
    expect(list[0]?.removesAt).toBe(removesAt);
    expect(await confirmFor(E, [u.userId], [{ action: "merge" }])).toBe(
      "passkey",
    );
    // A second request does not move the time.
    const again = await api(app, R.passkey(passkey.id), u.fresh, {
      method: "DELETE",
    });
    expect((await json<{ removesAt: string }>(again)).removesAt).toBe(
      removesAt,
    );
    // Cancel (session only; nothing pending: 404).
    expect(
      (
        await api(app, R.passkeyCancelRemoval(passkey.id), u.pat, {
          method: "POST",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(app, R.passkeyCancelRemoval(passkey.id), u.cookie, {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    expect(
      (await json<Passkey[]>(await api(app, R.passkeys, u.cookie)))[0]
        ?.removesAt,
    ).toBeNull();
    expect(
      (
        await api(app, R.passkeyCancelRemoval(passkey.id), u.cookie, {
          method: "POST",
        })
      ).status,
    ).toBe(409);
  });

  it("a scheduled removal takes effect when its time comes", async () => {
    const u = await mk("rm4");
    const { passkey } = await addPasskey(u);
    await api(app, R.passkey(passkey.id), u.fresh, { method: "DELETE" });
    await E.DB.prepare("update passkeys set removal_at = ? where id = ?")
      .bind(Date.now() - 1, passkey.id)
      .run();
    expect(await json<Passkey[]>(await api(app, R.passkeys, u.cookie))).toEqual(
      [],
    );
    expect(await confirmFor(E, [u.userId], [{ action: "merge" }])).toBe(
      undefined,
    );
  });

  it("an assertion removes it at once", async () => {
    const u = await mk("rm5");
    const { a, passkey } = await addPasskey(u);
    await api(app, R.passkey(passkey.id), u.fresh, { method: "DELETE" });
    const c = await json<PasskeyChallenge>(
      await get(u, {}, R.passkeyChallenge(passkey.id)),
    );
    const done = await api(app, R.passkey(passkey.id), u.cookie, {
      method: "DELETE",
      body: { assertion: await assertFor(a, c) },
    });
    expect(done.status).toBe(204);
    expect(await json<Passkey[]>(await api(app, R.passkeys, u.cookie))).toEqual(
      [],
    );
  });

  it("an assertion bound to another passkey's removal fails", async () => {
    const u = await mk("rm3");
    const one = await addPasskey(u);
    const two = await addPasskey(u);
    const c = await json<PasskeyChallenge>(
      await get(u, {}, R.passkeyChallenge(one.passkey.id)),
    );
    const assertion = await assertFor(one.a, c);
    const r = await api(app, R.passkey(two.passkey.id), u.cookie, {
      method: "DELETE",
      body: { assertion },
    });
    expect([400, 410]).toContain(r.status);
    expect(
      (await json<Passkey[]>(await api(app, R.passkeys, u.cookie))).length,
    ).toBe(2);
  });
});

describe("the passkey settings", () => {
  it("defaults to every action on and every pick off, with command locked", async () => {
    const u = await mk("set");
    const s = await json<PasskeySettings>(
      await api(app, R.passkeySettings, u.cookie),
    );
    expect(s).toMatchObject({
      ...ALL_ON,
      locked: ["command"],
      hasPasskey: false,
    });
  });

  it("refuses to turn run-a-command off", async () => {
    const u = await mk("set-cmd");
    const r = await api(app, R.passkeySettings, u.cookie, {
      method: "PATCH",
      body: off("command"),
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).message).toContain("Always on");
    expect(
      (
        await api(app, R.passkeySettingsChallenge, u.cookie, {
          method: "POST",
          body: off("command"),
        })
      ).status,
    ).toBe(400);
  });

  it("turning a switch on needs nothing, and an unchanged PUT writes nothing", async () => {
    const u = await mk("set-on");
    const r = await api(app, R.passkeySettings, u.cookie, {
      method: "PATCH",
      body: { ...ALL_ON, everyPick: true },
    });
    expect(r.status).toBe(200);
    expect((await json<PasskeySettings>(r)).everyPick).toBe(true);
    expect((await auditOf(u.userId, "passkey.settings"))[0]).toMatchObject({
      off: [],
      passkeyVerified: false,
    });
    const same = await api(app, R.passkeySettings, u.cookie, {
      method: "PATCH",
      body: { ...ALL_ON, everyPick: true },
    });
    expect(same.status).toBe(200);
    expect((await auditOf(u.userId, "passkey.settings")).length).toBe(1);
  });

  it("turning one off: no passkey, cooling passkey, then no assertion", async () => {
    const u = await mk("set-off");
    const put = (body: object) =>
      api(app, R.passkeySettings, u.cookie, { method: "PATCH", body });
    const none = await put(off("merge"));
    expect(none.status).toBe(409);
    expect((await errOf(none)).code).toBe("no_passkey");
    const { a } = await addPasskey(u, u.fresh, false);
    const cooling = await put(off("merge"));
    expect(cooling.status).toBe(409);
    expect((await errOf(cooling)).code).toBe("passkey_cooling");
    await E.DB.prepare("update passkeys set created_at = ? where user_id = ?")
      .bind(Date.now() - 2 * DAY, u.userId)
      .run();
    const missing = await put(off("merge"));
    expect(missing.status).toBe(403);
    expect((await errOf(missing)).code).toBe("passkey_required");
    // An assertion for a different change fails; the right one works once.
    const wrong = await json<PasskeyChallenge>(
      await get(u, off("deploy"), R.passkeySettingsChallenge),
    );
    const bad = await put({
      ...off("merge"),
      assertion: await assertFor(a, wrong),
    });
    expect(bad.status).toBe(400);
    expect((await errOf(bad)).code).toBe("passkey_failed");
    const c = await json<PasskeyChallenge>(
      await get(u, off("merge"), R.passkeySettingsChallenge),
    );
    const assertion = await assertFor(a, c);
    const ok = await put({ ...off("merge"), assertion });
    expect(ok.status).toBe(200);
    expect((await json<PasskeySettings>(ok)).actions.merge).toBe(false);
    expect((await auditOf(u.userId, "passkey.settings"))[0]).toMatchObject({
      off: ["merge"],
      passkeyVerified: true,
    });
    // The same assertion again: the challenge is spent.
    const reuse = await put({ ...off("merge", "share"), assertion });
    expect(reuse.status).toBe(410);
    expect((await errOf(reuse)).code).toBe("challenge_expired");
    expect(
      (await json<PasskeySettings>(await api(app, R.passkeySettings, u.cookie)))
        .actions.share,
    ).toBe(true);
  });

  it("refuses a malformed assertion before verifying (400 bad_request)", async () => {
    const u = await mk("set-bad");
    for (const assertion of [
      { id: "x" },
      "text",
      { id: "a!", rawId: "a", type: "public-key", response: {} },
      {
        id: "a",
        rawId: "a",
        type: "other",
        response: {
          clientDataJSON: "a",
          authenticatorData: "a",
          signature: "a",
        },
      },
      {
        id: "a",
        rawId: "a",
        type: "public-key",
        response: {
          clientDataJSON: "a".repeat(5000),
          authenticatorData: "a",
          signature: "a",
        },
      },
      {
        id: "a",
        rawId: "a",
        type: "public-key",
        extra: 1,
        response: {
          clientDataJSON: "a",
          authenticatorData: "a",
          signature: "a",
        },
      },
    ]) {
      const r = await api(app, R.passkeySettings, u.cookie, {
        method: "PATCH",
        body: { ...off("merge"), assertion },
      });
      expect(r.status).toBe(400);
      expect((await errOf(r)).code).toBe("bad_request");
    }
  });

  it("a token cannot read or change them", async () => {
    const u = await mk("set-tok");
    expect((await api(app, R.passkeySettings, u.pat)).status).toBe(403);
    expect(
      (
        await api(app, R.passkeySettings, u.pat, {
          method: "PATCH",
          body: ALL_ON,
        })
      ).status,
    ).toBe(403);
  });
});

describe("challenges", () => {
  it("expire, and a new one voids the old", async () => {
    const u = await mk("ch");
    const { a } = await addPasskey(u);
    const body = off("deploy");
    const first = await json<PasskeyChallenge>(
      await get(u, body, R.passkeySettingsChallenge),
    );
    const second = await json<PasskeyChallenge>(
      await get(u, body, R.passkeySettingsChallenge),
    );
    expect(second.options.challenge).not.toBe(first.options.challenge);
    const put = (assertion: unknown) =>
      api(app, R.passkeySettings, u.cookie, {
        method: "PATCH",
        body: { ...body, assertion },
      });
    // The voided challenge's assertion carries the wrong challenge.
    expect((await put(await assertFor(a, first))).status).toBe(400);
    // That burnt the live one; ask again, then let it run out.
    const third = await json<PasskeyChallenge>(
      await get(u, body, R.passkeySettingsChallenge),
    );
    await E.DB.prepare(
      "update pick_assertions set expires_at = ? where user_id = ?",
    )
      .bind(Date.now() - 1, u.userId)
      .run();
    const late = await put(await assertFor(a, third));
    expect(late.status).toBe(410);
  });

  it("are limited per member", async () => {
    const u = await mk("ch-spam");
    await addPasskey(u);
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++)
      last = (await get(u, off("deploy"), R.passkeySettingsChallenge)).status;
    expect(last).toBe(429);
  });
});

describe("the removal email", () => {
  it("says it goes in 24 hours when pending, and that it is gone otherwise", () => {
    const base = {
      instance: "Acme",
      recipient: "a@x.com",
      appHost: "app.example.com",
      label: "Laptop",
    };
    const pending = passkeyRemovedEmail({ ...base, pending: true });
    expect(pending.subject).toContain("will be removed");
    expect(pending.text).toContain("24 hours");
    expect(pending.text).toContain("/settings/security");
    const gone = passkeyRemovedEmail({ ...base, pending: false });
    expect(gone.subject).toContain("was removed");
  });
});

describe("a failed check burns the challenge", () => {
  it("a settings assertion for another change fails, and then the right change finds it spent", async () => {
    const u = await mk("burn");
    const { a } = await addPasskey(u);
    const c = await json<PasskeyChallenge>(
      await get(u, off("deploy"), R.passkeySettingsChallenge),
    );
    const assertion = await assertFor(a, c);
    const patch = (body: object) =>
      api(app, R.passkeySettings, u.cookie, { method: "PATCH", body });
    expect((await patch({ ...off("merge"), assertion })).status).toBe(400);
    expect((await patch({ ...off("deploy"), assertion })).status).toBe(410);
  });
});
