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

/** POST a /__test/* hook with rl-a's key: the raw response. */
export const hookRes = (path: string, body: unknown = {}) =>
  post(path, body, { authorization: `Bearer ${KEY}` });

/** POST a /__test/* hook with rl-a's key; throws with the status unless 2xx. */
export async function hook<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await hookRes(path, body);
  if (!res.ok) throw new Error(`rl-a hook ${path}: ${res.status}`);
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
  return { ...p, id: me.user.id, page: await ctx.newPage() };
}

/** An API call as `p` (X-OA-Request set), bounded. */
export const api = (
  p: Pick<Person, "cookie">,
  path: string,
  init: RequestInit = {},
) =>
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

/** A GET retried once on a transient answer (network error, 502 to 504). */
export async function get(p: Pick<Person, "cookie">, path: string) {
  for (let i = 0; ; i++) {
    const res = await api(p, path).catch((e: unknown) => {
      if (i > 0) throw e;
      return null;
    });
    if (res && (i > 0 || ![502, 503, 504].includes(res.status))) return res;
  }
}

/** Artifacts this run made, deleted (by their owner, through the API) by `cleanup`. */
const made: { by: Person; id: string }[] = [];

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
  made.push({ by, id: r.id });
  return r;
}

/** `cleanup` deletes `id` as `by` (an artifact made in the UI, or one that changed owner). */
export const remember = (by: Person, id: string) => made.push({ by, id });

/** Soft-deletes every artifact this run made; one already gone (404) is fine. */
export async function cleanup(): Promise<void> {
  const left = made.splice(0);
  const failed: string[] = [];
  for (const { by, id } of left) {
    const res = await api(by, R.artifact(id), { method: "DELETE" }).catch(
      () => null,
    );
    if (!res || (res.status !== 204 && res.status !== 404)) failed.push(id);
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
      await get(admin, `${R.spaces}?${q}`),
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
  version ??= fetch(`${A.app}/healthz`, {
    signal: AbortSignal.timeout(FETCH_MS),
  })
    .then((r) => json<{ version: string }>(r))
    .then((h) => h.version);
  return version;
};

/** Semver order of two x.y.z versions (a prerelease suffix is ignored). */
export const below = (v: string, min: string): boolean => {
  const n = (s: string) => s.split(/[-+]/)[0].split(".").map(Number);
  const [a, b] = [n(v), n(min)];
  for (let i = 0; i < 3; i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

/** Skips the running test until rl-a runs `min` or later. */
export async function needs(min: string): Promise<void> {
  test.skip(below(await rlAVersion(), min), `needs ${min}`);
}

export const test = base;
export { expect };
