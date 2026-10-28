import { randomBytes } from "node:crypto";
import { type Role, TEST_HOOKS, type TestSessionInput } from "@oa/shared";
import { type Browser, test as base, type Page } from "@playwright/test";
import { FETCH_MS, hookKey, rlA } from "../targets";

// rl-a's helpers: sessions through TEST_HOOKS.session for users in its
// TEST_DOMAIN, named t19-<run>-<tag> so a run's people are easy to find.

export const A = rlA();
const KEY = hookKey(A.hookKeyFile);
export const RUN = randomBytes(3).toString("hex");
const COOKIE = "__Host-oa_session";

const post = (path: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${A.app}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_MS),
  });

/** POST a /__test/* hook with rl-a's key; throws with the status unless 2xx. */
export async function hook<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await post(path, body, { authorization: `Bearer ${KEY}` });
  if (!res.ok) throw new Error(`rl-a hook ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export const email = (tag: string) => `t19-${RUN}-${tag}@${A.testDomain}`;

export type Person = { email: string; cookie: string; page: Page };

/** A signed-in person with their own browser context. */
export async function person(
  browser: Browser,
  tag: string,
  role: Role,
  spaces?: TestSessionInput["spaces"],
): Promise<Person> {
  const who = email(tag);
  const { cookie } = await hook<{ cookie: string }>(TEST_HOOKS.session, {
    email: who,
    role,
    ...(spaces ? { spaces } : {}),
  } satisfies TestSessionInput);
  const ctx = await browser.newContext({ baseURL: A.app });
  await ctx.addCookies([
    {
      name: COOKIE,
      value: cookie,
      url: A.app,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return { email: who, cookie, page: await ctx.newPage() };
}

/** An API call as `p` (X-OA-Request set), bounded. */
export const api = (p: Person, path: string, init: RequestInit = {}) =>
  fetch(`${A.app}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      cookie: `${COOKIE}=${p.cookie}`,
      "x-oa-request": "1",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(FETCH_MS),
  });

export const test = base;
export { expect } from "@playwright/test";
