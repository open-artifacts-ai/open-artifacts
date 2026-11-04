import { randomBytes } from "node:crypto";
import {
  type Me,
  type PublishInput,
  type PublishResult,
  R,
  type Role,
  type Space,
  TEST_HOOKS,
  type TestSessionInput,
} from "@oa/shared";
import {
  type Browser,
  test as base,
  expect,
  type Page,
} from "@playwright/test";
import { gate } from "../gate";
import { hookFailure, paceT19Hook } from "../hook-pace";
import { sendRead } from "../retry";
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

/**
 * POST a /__test/* hook with rl-a's key: the raw response. Paced first
 * (hook-pace.ts): every /__test/* call counts against RL_ANON.
 */
export async function hookRes(path: string, body: unknown = {}) {
  await paceT19Hook(A.app);
  return post(path, body, { authorization: `Bearer ${KEY}` });
}

/** POST a /__test/* hook with rl-a's key; throws with the status unless 2xx. */
export async function hook<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await hookRes(path, body);
  if (!res.ok) throw hookFailure(A.app, `rl-a hook ${path}`, res.status);
  return (await res.json()) as T;
}

export const email = (tag: string) => `t19-${RUN}-${tag}@${A.testDomain}`;

export type Person = {
  email: string;
  cookie: string;
  page: Page;
  /** Their user id (also their personal space id). */
  id: string;
  /** The display name the UI shows: "T19 <run> <tag>". */
  name: string;
};

/** A signed-in person with their own browser context, named so the display-name prompt never opens. */
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
  const name = `T19 ${RUN} ${tag}`;
  const p = { email: who, cookie, name, id: "" };
  const me = await json<Me>(
    await api(p, R.me, {
      method: "PATCH",
      body: JSON.stringify({ displayName: name }),
    }),
  );
  // Space roles the hook granted: this file's cleanup takes them away again.
  for (const s of spaces ?? [])
    grantedHere().push({ spaceId: s.spaceId, userId: me.user.id });
  return { ...p, id: me.user.id, page: await ctx.newPage() };
}

/**
 * An API call as `p` (X-OA-Request set), bounded. A GET that gets no response
 * is sent again (retry.ts), so a poll keeps polling; writes never are.
 */
export const api = (
  p: Pick<Person, "cookie">,
  path: string,
  init: RequestInit = {},
) =>
  sendRead(init.method, () =>
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
    }),
  );

/** An anonymous call to rl-a, bounded; a GET with no response is sent again. */
export const anon = (path: string, init: RequestInit = {}) =>
  sendRead(init.method, () =>
    fetch(`${A.app}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_MS),
    }),
  );

/** The body of a 2xx response; anything else throws with its status. */
export async function json<T>(res: Response): Promise<T> {
  if (!res.ok)
    throw new Error(`rl-a ${res.url.replace(A.app, "")}: ${res.status}`);
  return (await res.json()) as T;
}

/** The `error.code` of a refusal, after checking its status. */
export async function refusal(res: Response, status: number): Promise<string> {
  expect(res.status, res.url.replace(A.app, "")).toBe(status);
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  return body.error?.code ?? "";
}

/**
 * Artifacts each spec file made, keyed by the file, so its `cleanup` deletes
 * only its own: one file's afterAll never touches another's (#1251).
 */
const perFile = <T>() => {
  const all = new Map<string, T[]>();
  return () => {
    const file = base.info().file;
    const list = all.get(file) ?? [];
    all.set(file, list);
    return list;
  };
};
const madeHere = perFile<{ by: Person; id: string }>();
/**
 * Space roles each file's people got through the session hook, removed again
 * by that file's `cleanup`, so the fixed t19 spaces don't gain members per
 * run (#1251).
 */
const grantedHere = perFile<{ spaceId: string; userId: string }>();

/**
 * Publishes as `p` and remembers the artifact for `cleanup`, which deletes it
 * as `by` (default `p`): in a shared space only a manager may delete.
 */
export async function publish(
  p: Person,
  input: PublishInput,
  by: Person = p,
): Promise<PublishResult> {
  const r = await json<PublishResult>(
    await api(p, R.artifacts, { method: "POST", body: JSON.stringify(input) }),
  );
  madeHere().push({ by, id: r.id });
  return r;
}

/** `cleanup` deletes `id` as `by` (an artifact made in the UI, or one that changed owner). */
export const remember = (by: Person, id: string) => madeHere().push({ by, id });

/**
 * Soft-deletes every artifact this file made, then takes away every space
 * role its people were granted (as an org admin, who may remove any manual
 * member). One already gone (404) is fine.
 */
export async function cleanup(): Promise<void> {
  const left = madeHere().splice(0);
  const failed: string[] = [];
  for (const { by, id } of left) {
    const res = await api(by, R.artifact(id), { method: "DELETE" }).catch(
      () => null,
    );
    if (!res || (res.status !== 204 && res.status !== 404)) failed.push(id);
  }
  const roles = grantedHere().splice(0);
  if (roles.length) {
    const { cookie } = await hook<{ cookie: string }>(TEST_HOOKS.session, {
      email: email("admin"),
      role: "admin",
    } satisfies TestSessionInput);
    const done = new Set<string>();
    for (const { spaceId, userId } of roles) {
      const key = `${spaceId} ${userId}`;
      if (done.has(key)) continue;
      done.add(key);
      const res = await api({ cookie }, R.spaceMember(spaceId, userId), {
        method: "DELETE",
      }).catch(() => null);
      if (!res || ![200, 204, 404].includes(res.status)) failed.push(key);
    }
  }
  if (failed.length) throw new Error(`T19 cleanup left ${failed.join(", ")}`);
}

/** A page with live data (db on), so a read-only viewer gets the View only chip. */
export const liveHtml = (title: string): PublishInput => ({
  title,
  format: "html",
  content: `<!doctype html><title>${title}</title><p>${title}</p>`,
  capabilities: { db: true },
  dataWriters: "editors",
});

// The fixed spaces T19 reuses on rl-a. The hooks grant roles only in
// `test-` spaces, so these ids are fixed; the names are what people see.
export const SPACES = {
  eng: { id: "test-t19-eng", name: "t19-eng" },
  exec: { id: "test-t19-exec", name: "t19-exec" },
} as const;

/** Every shared space the admin can list (all of them, for an org admin). */
async function sharedSpaces(admin: Person): Promise<Space[]> {
  const out: Space[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ kind: "shared", limit: "200" });
    if (cursor) q.set("cursor", cursor);
    const page = await json<{ items: Space[]; nextCursor: string | null }>(
      await api(admin, `${R.spaces}?${q}`),
    );
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/**
 * Finds t19-eng and t19-exec by name (the admin's GET R.spaces), and makes
 * whichever is missing: the session hook creates the `test-` space (granting
 * the admin manager), then the admin names it. Never deletes a space.
 */
export async function t19Spaces(admin: Person): Promise<void> {
  const all = await sharedSpaces(admin);
  for (const { id, name } of Object.values(SPACES)) {
    if (all.some((s) => s.id === id && s.name === name)) continue;
    if (!all.some((s) => s.id === id))
      await hook(TEST_HOOKS.session, {
        email: admin.email,
        role: "admin",
        spaces: [{ spaceId: id, role: "manager" }],
      } satisfies TestSessionInput);
    await json(
      await api(admin, R.space(id), {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    );
  }
}

/** rl-a's version, from /healthz (read once). */
let version: Promise<string> | undefined;
export const rlAVersion = () => {
  version ??= anon("/healthz")
    .then((r) => json<{ version: string }>(r))
    .then((h) => h.version);
  return version;
};

/**
 * Gates the running test on rl-a's version (gate.ts): skipped on an older
 * rl-a, but a failure on the gate run (T19_EXPECT_VERSION set).
 */
export async function needs(flow: string, min: string): Promise<void> {
  const v = await rlAVersion();
  const why = gate(flow, min, v, process.env.T19_EXPECT_VERSION);
  test.skip(why !== null, why ?? "");
}

export const test = base;
export { expect };
