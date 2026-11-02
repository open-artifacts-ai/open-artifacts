import { createHash } from "node:crypto";
import {
  type Cred,
  HttpError,
  hook,
  parseJson,
  readBody,
  withCred,
} from "./http.ts";
import { codeAccepted, latestOtp, requestCode, verifyReq } from "./signin.ts";
import type { Target } from "./targets.ts";

// The held-sweep snooze owner path (#1078, #854, #412). The directory-held
// hook puts a held sweep on a suite group (where real sync keeps holds);
// then the org owner snoozes it (it leaves Me's heldSweeps and shows
// snoozedUntil), cancels the snooze (it counts again), and the audit log
// carries directory.sweep.snoozed and directory.sweep.unsnoozed
// { why: owner_cancel }. The hold is taken off again whatever happens.
//
// Hooks never mint the owner, so the owner signs in the real way (a code to
// the owner's address, read through otp/latest), which only works when that
// address is under TEST_DOMAIN. Every message here is public: no email,
// host or install id, only the target's name.

export const GROUPS_HOOK = "/__test/directory-groups";
export const HELD_HOOK = "/__test/directory-held";
const ME = "/api/v1/me";
const MEMBERS = "/api/v1/members";
const AUDIT = "/api/v1/audit?limit=100";
const snoozePath = (gid: string) =>
  `/api/v1/directory/held/${encodeURIComponent(gid)}/snooze`;
/** The snooze's reason: short, and the server keeps it on the hold. */
export const SNOOZE_REASON = "red-line snooze check";
/** Clock skew allowed between this runner and the install. */
const SKEW_MS = 5 * 60_000;

/** The fixed suite group the case holds (the worldGroups `test-` rule). */
export function snoozeGroup(testDomain: string): {
  groupId: string;
  email: string;
} {
  const domain = testDomain.toLowerCase();
  const tag = createHash("sha256").update(domain).digest("hex").slice(0, 8);
  const groupId = `test-redline-snooze-${tag}`;
  return { groupId, email: `${groupId}@${domain}` };
}

/** The fixed reasons a target can't run the case (public). */
export const NOT_GOOGLE =
  "directory sync is not on Google sync here, so a snooze is refused (409)";
export const NO_OWNER =
  "the org owner's address is outside the test domain, so no owner session can be made";

export type SnoozeResult =
  | { level: "pass"; target: string }
  | { level: "unproven-live"; reason: string };

/** GET or a JSON write with `cred`; throws HttpError unless `ok`. */
async function call(
  t: Target,
  cred: Cred,
  method: string,
  path: string,
  what: string,
  body?: unknown,
  ok: readonly number[] = [200],
): Promise<unknown> {
  const headers: Record<string, string> = {
    "x-oa-request": "1",
    origin: t.app,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(
    `${t.app}${path}`,
    withCred(cred, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await readBody(res);
  const label = `${t.name} ${what}`;
  if (!ok.includes(res.status)) throw new HttpError(label, res, text);
  return text ? parseJson(res, text, label) : null;
}

type Me = {
  user?: { email?: unknown; role?: unknown };
  instance?: { directory?: { mode?: unknown; heldSweeps?: unknown } };
};
const meOf = async (t: Target, cred: Cred, what: string) =>
  (await call(t, cred, "GET", ME, what)) as Me;

/** Me.instance.directory.heldSweeps for `cred` (a number, else throws). */
export async function heldSweeps(
  t: Target,
  cred: Cred,
  what: string,
): Promise<number> {
  const n = (await meOf(t, cred, what)).instance?.directory?.heldSweeps;
  if (typeof n !== "number")
    throw new Error(`${t.name} ${what}: Me has no heldSweeps`);
  return n;
}

/** The org owner's address when it is under TEST_DOMAIN, else null. */
export async function ownerAddress(
  t: Target,
  adminPat: Cred,
): Promise<string | null> {
  const rows = (await call(t, adminPat, "GET", MEMBERS, "members")) as {
    email?: unknown;
    role?: unknown;
  }[];
  if (!Array.isArray(rows)) throw new Error(`${t.name} members: not a list`);
  const owner = rows.find((r) => r.role === "owner");
  const email = typeof owner?.email === "string" ? owner.email : "";
  return email.toLowerCase().endsWith(`@${t.testDomain.toLowerCase()}`)
    ? email
    : null;
}

/** An owner session through the real code sign-in. */
export async function ownerSession(t: Target, email: string): Promise<Cred> {
  const req = await requestCode(t, email);
  if (req.status !== 202 || !req.pending)
    throw new Error(
      `${t.name} owner code request: status ${req.status}, pending cookie ${req.pending ? "set" : "missing"}`,
    );
  const code = await latestOtp(t, email);
  if (!code) throw new Error(`${t.name} owner code: none arrived`);
  const res = await fetch(verifyReq(t, code, req.pending), {
    redirect: "manual",
  });
  const text = await readBody(res);
  if (!codeAccepted(res))
    throw new HttpError(`${t.name} owner code verify`, res, text);
  for (const line of res.headers.getSetCookie()) {
    const [p = ""] = line.split(";");
    const i = p.indexOf("=");
    const name = p.slice(0, i).trim();
    const value = p.slice(i + 1).trim();
    if (name === t.cookieName && value) return { kind: "cookie", name, value };
  }
  throw new Error(`${t.name} owner code verify: no ${t.cookieName} cookie`);
}

type Held = { groupId?: unknown; snoozedUntil?: unknown };
/** The group's snoozedUntil in a SyncStatus body (undefined: not held). */
const snoozedUntilIn = (status: unknown, gid: string): unknown => {
  const held = (status as { held?: Held[] } | null)?.held;
  if (!Array.isArray(held)) return undefined;
  const x = held.find((h) => h.groupId === gid);
  return x ? (x.snoozedUntil ?? null) : undefined;
};

type AuditRow = {
  at?: unknown;
  action?: unknown;
  target?: { type?: unknown; id?: unknown };
  detail?: { why?: unknown } | null;
};

/**
 * Runs the case on `t`: unproven-live with a fixed reason when `t` is not on
 * Google sync or its owner can't sign in; else pass, or a throw that says
 * which step failed. `ownerCred` stands in for the code sign-in in tests.
 */
export async function snoozeOwnerPath(
  t: Target,
  adminPat: Cred,
  o: { ownerCred?: (email: string) => Promise<Cred> } = {},
): Promise<SnoozeResult> {
  const mode = (await meOf(t, adminPat, "admin Me")).instance?.directory?.mode;
  if (mode !== "google") return { level: "unproven-live", reason: NOT_GOOGLE };
  const email = await ownerAddress(t, adminPat);
  if (!email) return { level: "unproven-live", reason: NO_OWNER };
  const owner = await (o.ownerCred ?? ((e) => ownerSession(t, e)))(email);
  const g = snoozeGroup(t.testDomain);
  const since = Date.now() - SKEW_MS;
  await hook(t, GROUPS_HOOK, { groups: [g] }, { setup: true });
  // A hold left by an earlier run that stopped partway goes first.
  await hook(t, HELD_HOOK, { ...g, held: false }, { setup: true });
  const base = await heldSweeps(t, owner, "owner Me before the hold");
  let failed: unknown = null;
  try {
    const on = (await hook(t, HELD_HOOK, { ...g, held: true })) as {
      held?: unknown;
    };
    if (on.held !== true)
      throw new Error(`${t.name} held hook: the group is not held`);
    const held = await heldSweeps(t, owner, "owner Me after the hold");
    if (held !== base + 1)
      throw new Error(
        `${t.name}: heldSweeps is ${held} after the hold, want ${base + 1}`,
      );
    const snoozed = await call(
      t,
      owner,
      "POST",
      snoozePath(g.groupId),
      "owner snooze",
      { reason: SNOOZE_REASON },
    );
    const until = snoozedUntilIn(snoozed, g.groupId);
    if (typeof until !== "string" || !(Date.parse(until) > Date.now()))
      throw new Error(
        `${t.name} owner snooze: the hold has no future snoozedUntil`,
      );
    const after = await heldSweeps(t, owner, "owner Me after the snooze");
    if (after !== base)
      throw new Error(
        `${t.name}: heldSweeps is ${after} after the snooze, want ${base} (the snoozed hold still counts)`,
      );
    const cancelled = await call(
      t,
      owner,
      "DELETE",
      snoozePath(g.groupId),
      "owner cancel",
    );
    if (snoozedUntilIn(cancelled, g.groupId) !== null)
      throw new Error(
        `${t.name} owner cancel: the hold is missing or still snoozed`,
      );
    const back = await heldSweeps(t, owner, "owner Me after the cancel");
    if (back !== base + 1)
      throw new Error(
        `${t.name}: heldSweeps is ${back} after the cancel, want ${base + 1}`,
      );
    const page = (await call(t, owner, "GET", AUDIT, "owner audit")) as {
      items?: AuditRow[];
    };
    const rows = (page?.items ?? []).filter(
      (r) =>
        r.target?.type === "group" &&
        r.target.id === g.groupId &&
        typeof r.at === "string" &&
        Date.parse(r.at) >= since,
    );
    if (!rows.some((r) => r.action === "directory.sweep.snoozed"))
      throw new Error(
        `${t.name} audit: no directory.sweep.snoozed row for the suite group`,
      );
    if (
      !rows.some(
        (r) =>
          r.action === "directory.sweep.unsnoozed" &&
          r.detail?.why === "owner_cancel",
      )
    )
      throw new Error(
        `${t.name} audit: no directory.sweep.unsnoozed { why: owner_cancel } row for the suite group`,
      );
  } catch (e) {
    failed = e;
  }
  // Always taken off; the first failure (the case's own, else this) wins.
  try {
    const off = (await hook(t, HELD_HOOK, { ...g, held: false })) as {
      held?: unknown;
    };
    if (off.held !== false)
      throw new Error(`${t.name} held hook: the hold was not taken off`);
    // The hook's answer alone can't show a held-list entry left behind.
    const after = await heldSweeps(t, owner, "owner Me after the release");
    if (after !== base)
      throw new Error(
        `${t.name}: heldSweeps is ${after} after the release, want ${base} (the hold still counts)`,
      );
  } catch (e) {
    failed ??= e;
  }
  if (failed) throw failed;
  return { level: "pass", target: t.name };
}
