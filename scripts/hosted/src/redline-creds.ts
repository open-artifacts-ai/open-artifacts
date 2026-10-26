// `oa:hosted redline-creds` (P5): the red-line suite's credentials for one
// staging test install (rl-a or rl-b), set straight into the GitHub
// Environment redline-staging. Backend's contract: the test-hook key buys a
// session for the suite's ADMIN test user (never the owner), and that session
// mints one PAT. The token API has no scope or expiry, so each run mints a
// fresh PAT, sets it, then revokes every earlier redline-* PAT of that user:
// at most one is live. Values go to `gh secret set` on stdin only; they are
// never in argv, a child's environment, a file or the output.
import { join } from "node:path";
import type { InstallRow } from "@oa/provision";

/** The two red-line installs and their secret-name stems. */
export const REDLINE_SLUGS: Record<string, string> = {
  "rl-a": "REDLINE_RL_A",
  "rl-b": "REDLINE_RL_B",
};
export const REDLINE_ENVIRONMENT = "redline-staging";
export const REDLINE_LABEL_PREFIX = "redline-";
/** The install's session cookie (never the dev name: staging is not dev). */
const SESSION_COOKIE = "__Host-oa_session";

export class CredsRefused extends Error {}

export interface CredsDeps {
  fetch: typeof fetch;
  /** The hook key from create's 0600 file, read without following a symlink. */
  readHookKey: (path: string) => string;
  /** `gh secret set <name> --env redline-staging`, the value on stdin. */
  setSecret: (name: string, value: string) => Promise<void>;
  /** Registers a value for redaction before it can reach any output. */
  hide: (value: string) => void;
  home: string;
  now: number;
}

export interface CredsResult {
  slug: string;
  secrets: string[];
  revoked: number;
}

const stamp = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 12);

/** Only the status: a body can carry the install's own error text. */
async function call(
  d: CredsDeps,
  url: string,
  init: RequestInit,
  what: string,
  want: number[],
): Promise<Response> {
  const res = await d.fetch(url, { ...init, redirect: "manual" });
  if (!want.includes(res.status)) {
    await res.body?.cancel();
    throw new Error(`${what}: HTTP ${res.status}`);
  }
  return res;
}

export async function redlineCreds(
  id: string,
  row: InstallRow | undefined,
  d: CredsDeps,
): Promise<CredsResult> {
  if (!row || row.id !== id) throw new CredsRefused(`no install ${id}`);
  const stem = REDLINE_SLUGS[row.slug];
  if (!stem)
    throw new CredsRefused(
      `install ${id} is ${row.slug}, not a red-line install (rl-a, rl-b)`,
    );
  if (row.state !== "active")
    throw new CredsRefused(`install ${id} is ${row.state}, not active`);
  if (row.test_hooks !== 1)
    throw new CredsRefused(`install ${id} has no test hooks`);
  let testDomain: unknown;
  try {
    testDomain = (JSON.parse(row.vars ?? "{}") as Record<string, unknown>)
      .TEST_DOMAIN;
  } catch {
    testDomain = undefined;
  }
  if (typeof testDomain !== "string" || testDomain === "")
    throw new CredsRefused(`install ${id} has no TEST_DOMAIN`);
  const app = `https://${row.app_host}`;

  // The live install must be this row, with hooks on.
  const h = await call(d, `${app}/healthz`, {}, "healthz", [200]);
  const health = (await h.json().catch(() => null)) as {
    ok?: unknown;
    testHooks?: unknown;
    installId?: unknown;
  } | null;
  if (
    health?.ok !== true ||
    health.testHooks !== true ||
    health.installId !== id
  )
    throw new CredsRefused(
      `${row.app_host} /healthz is not install ${id} with test hooks on`,
    );

  const hookKey = d
    .readHookKey(
      join(
        d.home,
        ".open-artifacts",
        "hosted-staging",
        `${row.app_host}-hook-key`,
      ),
    )
    .trim();
  d.hide(hookKey);
  if (hookKey.length < 32)
    throw new CredsRefused("the hook key file is too short");

  const s = await call(
    d,
    `${app}/__test/session`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${hookKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: `redline-admin@${testDomain}`,
        role: "admin",
      }),
    },
    "test session",
    [200],
  );
  const cookie = ((await s.json().catch(() => null)) as { cookie?: unknown })
    ?.cookie;
  if (typeof cookie !== "string" || cookie === "")
    throw new Error("test session: no cookie");
  d.hide(cookie);
  const asAdmin = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      cookie: `${SESSION_COOKIE}=${cookie}`,
      "x-oa-request": "1",
    },
  });

  const l = await call(
    d,
    `${app}/api/v1/tokens`,
    asAdmin(),
    "list tokens",
    [200],
  );
  const listed = (await l.json().catch(() => null)) as unknown;
  if (!Array.isArray(listed)) throw new Error("list tokens: not a list");
  const prior = listed
    .filter(
      (t): t is { id: string; label: string } =>
        typeof t?.id === "string" &&
        typeof t?.label === "string" &&
        t.label.startsWith(REDLINE_LABEL_PREFIX),
    )
    .map((t) => t.id);

  const m = await call(
    d,
    `${app}/api/v1/tokens`,
    asAdmin({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: `${REDLINE_LABEL_PREFIX}${stamp(d.now)}` }),
    }),
    "mint token",
    [201],
  );
  const pat = ((await m.json().catch(() => null)) as { token?: unknown })
    ?.token;
  if (typeof pat !== "string" || !pat.startsWith("oa_pat_"))
    throw new Error("mint token: no token");
  d.hide(pat);

  // The new PAT works before anything is replaced.
  await call(
    d,
    `${app}/api/v1/me`,
    { headers: { authorization: `Bearer ${pat}` } },
    "new token check",
    [200],
  );

  const names = [`${stem}_PAT`, `${stem}_HOOK_KEY`];
  await d.setSecret(names[0] as string, pat);
  await d.setSecret(names[1] as string, hookKey);

  // Only now: the earlier redline-* PATs, so CI never holds a dead one.
  let revoked = 0;
  for (const t of prior) {
    await call(
      d,
      `${app}/api/v1/tokens/${encodeURIComponent(t)}`,
      asAdmin({ method: "DELETE" }),
      `revoke earlier token ${t}`,
      [204],
    );
    revoked++;
  }
  return { slug: row.slug, secrets: names, revoked };
}
