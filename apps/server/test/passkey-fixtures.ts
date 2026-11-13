import { env } from "cloudflare:workers";
import { newId, type Passkey, type PasskeyChallenge, R } from "@oa/shared";
import { expect } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { appOrigin } from "../src/http/errors.js";
import { api, login } from "./helpers.js";
import { FakeAuthenticator } from "./passkey-helper.js";

export const E = env as unknown as Env;
export const origin = appOrigin(E);
export const rpId = E.APP_HOST.split(":")[0] as string;
export const DAY = 24 * 3600 * 1000;
export const tag = newId().slice(0, 6).toLowerCase();

export type U = { cookie: string; fresh: string; userId: string; pat: string };

/** A member with a plain session, a fresh forced-sign-in session and a PAT. */
export async function mkUser(prefix: string): Promise<U> {
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
  return { ...l, fresh, pat: (await createPat(E, l.userId, "agent")).token };
}

type App = Parameters<typeof api>[0];

/** Registers a passkey through the routes; `age` back-dates it past the 24 h cooling. */
export async function addPasskey(
  app: App,
  u: U,
  auth = u.fresh,
  age = true,
): Promise<{ a: FakeAuthenticator; passkey: Passkey }> {
  const a = await FakeAuthenticator.create();
  const begin = await api(app, R.passkeyRegisterBegin, auth, {
    method: "POST",
  });
  expect(begin.status).toBe(200);
  const { options } = (await begin.json()) as PasskeyChallenge;
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
  const passkey = (await fin.json()) as Passkey;
  if (age)
    await E.DB.prepare("update passkeys set created_at = ? where id = ?")
      .bind(Date.now() - 2 * DAY, passkey.id)
      .run();
  return { a, passkey };
}

/** An assertion for the options a challenge route returned. */
export const assertFor = (
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
