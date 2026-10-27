import { hasDirectoryScopes } from "@oa/auth-core";
import type {
  DirectoryBinding,
  DirectoryConnectError,
  Member,
  SyncStatus,
} from "@oa/shared";
import { authConfig } from "../auth/config.js";
import { deriveKey } from "../auth/keys.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { logInfo, logWarn } from "../log.js";
import { type AuditActor, audit, userActor } from "../services/audit.js";
import { afterDirectoryConnect, resetSync } from "../services/directory.js";
import { directoryMode } from "../services/spaces.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
  sha256Hex,
} from "../util/crypto.js";
import { alertOwners, ownerEmails } from "./alert.js";
import { initialBinding, planPage, retireTenant } from "./binding.js";
import { directoryClient } from "./client.js";
import { seal } from "./crypto.js";
import {
  GoogleApiError,
  getUser,
  listUsers,
  verifiedDomains,
} from "./google.js";
import {
  healthFields,
  MISMATCH_TOMBSTONE,
  NEVER,
  readHealth,
  readSyncState,
} from "./health.js";
import {
  CONFIRM_TTL_MS,
  CONFIRM_WON,
  dropPending,
  expirePending,
  K,
  keepPrior,
  liveSub,
  type PendingConfirm,
  promotePending,
  putState,
  readBinding,
  readPending,
  readPendingRaw,
  readPrior,
  revokeAtGoogle,
  revokeGrant,
  type SqlGuard,
  wipeState,
} from "./store.js";
import {
  type DirectoryClient,
  directoryTransport,
  TransportError,
} from "./transport.js";

// Directory connect (P3 T12): GET R.directoryConnect starts consent for the
// org owner; GET R.directoryCallback runs every check in order and fails
// closed. Each refusal redirects to /settings/directory?error=<code> and
// writes a directory.connect audit row (ids and enums only). Success stores
// the binding, the sealed refresh token and a pending confirmation (with a
// one-page count of the users it would bind) and writes nothing to users,
// identities or memberships. The connecting owner then confirms
// (R.directoryConfirm: afterConsent runs the initial binding pass and hands
// off to T13) or cancels (R.directoryCancel). Unconfirmed for 24 h, it is
// dropped: lazily on the next status read or confirm, and by the daily cron.

export const SETTINGS_DIRECTORY = "/settings/directory";
const STATE_TTL_MS = 10 * 60_000;
const COOKIE_BASE = "oa_dir";
const enc = new TextEncoder();

const hostPrefixed = (env: Env) => env.ENVIRONMENT !== "dev";
export const dirCookieName = (env: Env) =>
  hostPrefixed(env) ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
const cookieAttrs = (env: Env) =>
  hostPrefixed(env)
    ? "HttpOnly; Secure; SameSite=Lax; Path=/"
    : "HttpOnly; SameSite=Lax; Path=/api/v1/directory";
const setCookie = (env: Env, value: string, maxAge: number) =>
  `${dirCookieName(env)}=${value}; ${cookieAttrs(env)}; Max-Age=${maxAge}`;
export const clearDirCookie = (env: Env) => setCookie(env, "", 0);

/** Connect is offered only with a transport and directory sync running. */
export function connectClient(env: Env): DirectoryClient | null {
  if (directoryMode(env) !== "google") return null;
  return directoryClient(env);
}

const random = (n: number) =>
  b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));
const s256 = async (v: string) =>
  b64urlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(v))),
  );

/** The signed state cookie: this browser, this user, this flow. */
type DirState = { s: string; v: string; u: string; exp: number };

async function signCookie(env: Env, st: DirState): Promise<string> {
  const p = b64urlEncode(enc.encode(JSON.stringify(st)));
  return `${p}.${await hmacSign(await deriveKey(env, "oa:directory-state"), p)}`;
}

async function readCookie(env: Env, v: string): Promise<DirState | null> {
  const [p, sig, extra] = v.split(".");
  if (!p || !sig || extra !== undefined) return null;
  if (!(await hmacVerify(await deriveKey(env, "oa:directory-state"), p, sig)))
    return null;
  try {
    const raw = b64urlDecode(p);
    const st = raw
      ? (JSON.parse(new TextDecoder().decode(raw)) as DirState)
      : null;
    if (
      !st ||
      typeof st.s !== "string" ||
      typeof st.v !== "string" ||
      typeof st.u !== "string" ||
      typeof st.exp !== "number"
    )
      return null;
    return st;
  } catch {
    return null;
  }
}

/** Constant-time string equality (SHA-256 digests compared). */
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([s256(a), s256(b)]);
  let d = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/**
 * Starts consent for `user` (the route checked directory.manage): records
 * the one pending flow (single use) and returns the redirect and cookie.
 */
export async function startConnect(
  env: Env,
  client: DirectoryClient,
  user: Member,
): Promise<{ location: string; cookie: string }> {
  const state = random(32);
  const verifier = random(32);
  const exp = Date.now() + STATE_TTL_MS;
  await putState(
    env,
    K.pending,
    JSON.stringify({ h: await sha256Hex(state), u: user.id, exp }),
  ).run();
  return {
    location: client.beginConsent({
      state,
      challenge: await s256(verifier),
      hd: authConfig(env).domains[0] as string,
    }),
    cookie: setCookie(
      env,
      await signCookie(env, { s: state, v: verifier, u: user.id, exp }),
      STATE_TTL_MS / 1000,
    ),
  };
}

/** Consumes the pending flow when it is this state's and this user's, unexpired. */
const CONSUME = `delete from directory_state
  where key = ? and json_extract(value, '$.h') = ?
    and json_extract(value, '$.u') = ? and json_extract(value, '$.exp') > ?
  returning key`;

export type CallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
  bstate?: string;
};

const target = (env: Env, q: Record<string, string>) => {
  const qs = new URLSearchParams(q).toString();
  return `${appOrigin(env)}${SETTINGS_DIRECTORY}${qs ? `?${qs}` : ""}`;
};

class Refuse extends Error {
  constructor(
    public code: DirectoryConnectError,
    public stage: string,
  ) {
    super(stage);
  }
}

const AUDIT_TARGET = { type: "directory", id: "google" } as const;

/**
 * The callback. Every check runs in this order and any failure refuses:
 * 1. the state cookie (signature, this user, unexpired, state equal) and the
 *    single-use pending flow: `expired`;
 * 2. Google's own error (consent declined): `denied`;
 * 3. the exchange (broker: its signed state for this install and the PKCE
 *    verifier; direct: Google's token endpoint): `failed`;
 * 4. every scope granted: `scopes`;
 * 5. hd is one of this install's domains: `domain_mismatch`;
 * 6. users.get(sub) is a super admin with a customer id: `not_super_admin`;
 * 7. a reconnect keeps the bound customer: `customer_mismatch`;
 * 8. domains.list(customerId) has hd verified: `domain_mismatch`.
 * Then the one-page count (a Google failure: `failed`), and the binding,
 * sealed token and pending confirmation in one batch.
 * Returns the redirect location (never carries a code or token).
 */
export async function finishConnect(
  env: Env,
  client: DirectoryClient,
  user: Member,
  q: CallbackQuery,
  cookie: string | undefined,
): Promise<string> {
  const actor = userActor(user.id);
  try {
    const now = Date.now();
    const st = cookie ? await readCookie(env, cookie) : null;
    if (
      !st ||
      st.exp <= now ||
      st.u !== user.id ||
      !q.state ||
      !(await same(st.s, q.state))
    )
      throw new Refuse("expired", "state");
    const consumed = await stmt(env.DB, CONSUME)
      .bind(K.pending, await sha256Hex(st.s), user.id, now)
      .first();
    if (!consumed) throw new Refuse("expired", "pending");
    if (q.error || !q.code) throw new Refuse("denied", "idp_error");

    let grant: Awaited<ReturnType<DirectoryClient["completeConsent"]>>;
    try {
      grant = await client.completeConsent({
        code: q.code,
        verifier: st.v,
        bstate: q.bstate,
      });
    } catch (e) {
      const stage = e instanceof TransportError ? e.stage : "exchange";
      throw new Refuse("failed", `transport_${stage}`);
    }
    if (!hasDirectoryScopes(grant.grantedScopes))
      throw new Refuse("scopes", "scopes");
    const domains = authConfig(env).domains;
    const hd = grant.hd?.toLowerCase() ?? "";
    if (!domains.includes(hd)) throw new Refuse("domain_mismatch", "hd");

    const google = async <T>(f: () => Promise<T>): Promise<T> => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof GoogleApiError)
          throw new Refuse("failed", `google_http_${e.status}`);
        throw e;
      }
    };
    const who = await google(() => getUser(grant.accessToken, grant.sub));
    if (!who || who.id !== grant.sub) throw new Refuse("failed", "user_get");
    // Delegated admins read isAdmin false: their listings can be partial
    // and still look complete.
    if (!who.isAdmin) throw new Refuse("not_super_admin", "not_super_admin");
    if (!who.customerId) throw new Refuse("failed", "no_customer");
    const { binding: prior } = await readBinding(env);
    if (prior && prior.customerId !== who.customerId)
      throw new Refuse("customer_mismatch", "customer");
    const verified = await google(() =>
      verifiedDomains(grant.accessToken, who.customerId as string),
    );
    if (!verified.includes(hd)) throw new Refuse("domain_mismatch", "domains");

    // Nothing is linked yet: count what confirm would bind (one page).
    const count = await google(() =>
      countPending(env, grant.accessToken, who.customerId as string),
    );
    const binding: DirectoryBinding = {
      provider: "google",
      customerId: who.customerId,
      domain: hd,
      connectedBy: user.id,
      connectedAt: new Date(now).toISOString(),
    };
    const pending: PendingConfirm = {
      u: user.id,
      exp: now + CONFIRM_TTL_MS,
      count: count.count,
      capped: count.capped,
      s: who.id,
    };
    // Pending rows only: a live connection (a reconnect) keeps syncing until
    // confirm swaps these in. An earlier unconfirmed consent is replaced and
    // its grant revoked.
    const [{ sealed: replaced }, before, live] = await Promise.all([
      readBinding(env, "pending"),
      readPending(env),
      liveSub(env),
    ]);
    await env.DB.batch([
      putState(env, K.pendingBinding, JSON.stringify(binding)),
      putState(env, K.pendingRefresh, await seal(env, grant.refreshToken)),
      putState(env, K.confirm, JSON.stringify(pending)),
      audit(env, "directory.connect", AUDIT_TARGET, actor, {
        detail: { outcome: "consented", transport: client.kind },
        when: {
          sql: `exists (select 1 from directory_state where key = ?
                  and json_extract(value, '$.customerId') = ?)`,
          args: [K.pendingBinding, who.customerId],
        },
      }),
    ]);
    logInfo("directory_connect", { outcome: "consented", kind: client.kind });
    if (replaced)
      await revokeGrant(env, replaced, actor, "pending", {
        sub: before?.s,
        keep: [live, who.id],
      });
    return target(env, {});
  } catch (e) {
    const r = e instanceof Refuse ? e : new Refuse("failed", "internal");
    if (!(e instanceof Refuse)) logWarn("directory_connect_internal", e);
    return refuseConnect(env, user, r.code, r.stage);
  }
}

/** Active, in-domain users on the first users.list page; capped past it ("500+"). */
async function countPending(
  env: Env,
  token: string,
  customerId: string,
): Promise<{ count: number; capped: boolean }> {
  const page = await listUsers(token, customerId);
  // `create` is exactly the active in-domain users.
  const { create } = planPage(new Set(authConfig(env).domains), page.users);
  return { count: create.length, capped: page.nextPageToken !== null };
}

/** One refusal: the log line, the audit row (ids and enums only), the redirect. */
export async function refuseConnect(
  env: Env,
  user: Member,
  code: DirectoryConnectError,
  stage: string,
): Promise<string> {
  logInfo("directory_connect", { outcome: code, stage });
  await audit(env, "directory.connect", AUDIT_TARGET, userActor(user.id), {
    detail: { outcome: "refused", error: code, stage },
  })
    .run()
    .catch((err) => logWarn("directory_connect_audit", err));
  return target(env, { error: code });
}

const notFound = () => new ApiError("not_found", "Not found");

/**
 * The pending confirmation `user` may act on: theirs (they started the
 * connect; the route checked they are still the org owner) and present.
 * Anyone else, or nothing pending: 404. An expired one is dropped (audited)
 * and answers 409 conflict.
 */
async function ownPending(env: Env, user: Member): Promise<PendingConfirm> {
  const p = await readPending(env);
  if (!p || p.u !== user.id) throw notFound();
  if (p.exp <= Date.now()) {
    await expirePending(env);
    throw new ApiError(
      "conflict",
      "The directory connection expired before it was confirmed; connect again",
    );
  }
  return p;
}

/**
 * POST R.directoryConfirm, the step after consent: swaps the pending
 * binding and token in as the live ones in one D1 batch, revokes the OLD
 * live grant at Google (best effort: a failure is audited, never an error),
 * then runs the binding pass (links and creates members) and hands off to
 * T13. Kept apart from storing the token so nothing is written to users,
 * identities or memberships before the owner confirms.
 */
export async function afterConsent(
  env: Env,
  client: DirectoryClient,
  user: Member,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<SyncStatus> {
  const p = await ownPending(env, user);
  const [
    { binding, sealed },
    { sealed: old, binding: was },
    oldSub,
    seen,
    prior,
  ] = await Promise.all([
    readBinding(env, "pending"),
    readBinding(env, "live"),
    liveSub(env),
    readPendingRaw(env),
    readPrior(env),
  ]);
  // The Workspace this confirm replaces: the live one, or the one a
  // disconnect during customer_mismatch removed.
  const previous = was?.customerId ?? prior?.customerId;
  if (!binding || !sealed || !seen) throw notFound();
  let token: string;
  try {
    token = await client.accessToken(sealed);
  } catch (e) {
    logWarn("directory_confirm_token", e);
    throw new ApiError(
      "conflict",
      "Google refused the stored grant; connect again",
    );
  }
  const swap = promotePending(env, user.id, Date.now(), seen);
  // Another Workspace than before: its users are retired (retireTenant).
  const change = !!previous && previous !== binding.customerId;
  const out = await env.DB.batch([
    ...swap,
    audit(env, "directory.connect", AUDIT_TARGET, userActor(user.id), {
      detail: {
        outcome: "confirmed",
        transport: client.kind,
        customerId: binding.customerId,
        ...(previous ? { previousCustomerId: previous } : {}),
      },
      when: { sql: "changes() > 0", args: [] },
    }),
    // Owed with the swap itself: a confirm that fails before retiring them
    // leaves this for DirectorySync, and the tombstone stays meanwhile.
    ...(change
      ? [
          stmt(
            env.DB,
            `insert into directory_state (key, value) select ?, ?
              where exists (select 1 from directory_state where key = ?
                and value = ?)
              on conflict (key) do update set value = excluded.value`,
          ).bind(K.retire, previous, K.binding, seen.binding),
        ]
      : []),
  ]);
  if (!out[CONFIRM_WON]?.meta.changes) {
    // Still pending for this owner: a newer consent replaced what we read.
    const now = await readPending(env);
    if (now && now.u === user.id && now.exp > Date.now())
      throw new ApiError(
        "conflict",
        "A newer directory consent arrived; review it and confirm again",
      );
    // A racing confirm or cancel (or the expiry) took it first.
    throw notFound();
  }
  logInfo("directory_connect", { outcome: "confirmed", kind: client.kind });
  // Before the binding pass links anyone to the new Workspace.
  if (change) await retireTenant(env, previous as string, ctx);
  if (old)
    await revokeGrant(env, old, userActor(user.id), "old", {
      // The new account unknown: it may be the same one, so never revoke.
      sub: p.s ? oldSub : null,
      keep: [p.s ?? null],
    });
  const pass = await initialBinding(
    env,
    token,
    binding.customerId,
    binding.domain,
    ctx,
  );
  await afterDirectoryConnect(env, { initialDone: pass.done }).catch((e) =>
    logWarn("directory_after_connect", e),
  );
  return directoryStatus(env, { showProblem: true });
}

/**
 * POST R.directoryCancel: drops only the pending token and binding
 * (audited); a live connection and its sync stay. The pending grant is then
 * revoked at Google (best effort).
 */
export async function cancelConnect(env: Env, user: Member): Promise<void> {
  const p = await ownPending(env, user);
  const { sealed } = await readBinding(env, "pending");
  const live = await liveSub(env);
  const out = await env.DB.batch([
    audit(env, "directory.disconnect", AUDIT_TARGET, userActor(user.id), {
      detail: { outcome: "cancelled" },
      when: {
        sql: "exists (select 1 from directory_state where key = ? and json_extract(value, '$.u') = ?)",
        args: [K.confirm, user.id],
      },
    }),
    dropPending(env),
  ]);
  if (!out[1]?.meta.changes) return;
  logInfo("directory_connect", { outcome: "cancelled" });
  if (sealed)
    await revokeGrant(env, sealed, userActor(user.id), "pending", {
      sub: p.s,
      keep: [live],
    });
}

/** The system job's disconnect kept the state: a revoke failed (retry). */
export class DisconnectRetry extends Error {
  constructor() {
    super("directory disconnect: revoke failed, state kept");
    this.name = "DisconnectRetry";
  }
}

/** What a disconnect did with a token at Google (directory.disconnect detail). */
type RevokeOutcome = "revoked" | "revoke_failed" | "none";

/** Any connection state: a live binding or token, or a pending consent. */
const CONNECTED = `exists (select 1 from directory_state where key in (?, ?, ?, ?, ?))`;
const CONNECTED_KEYS = [
  K.binding,
  K.refresh,
  K.pendingBinding,
  K.pendingRefresh,
  K.confirm,
];

/**
 * True while every live and pending token row is one of `seen` (the values
 * read before the revokes). A key empty at read time that now holds a row,
 * or a read key now holding another value, makes it false.
 */
const unseenTokens = (seen: (string | null)[]): SqlGuard => {
  const v = seen.filter((x): x is string => !!x);
  return {
    sql: `not exists (select 1 from directory_state
      where key in (?, ?)${v.length ? ` and value not in (${v.map(() => "?").join(", ")})` : ""})`,
    args: [K.refresh, K.pendingRefresh, ...v],
  };
};

const revokeOutcome = async (
  env: Env,
  sealed: string | null,
  which: "live" | "pending",
): Promise<RevokeOutcome> =>
  sealed
    ? (await revokeAtGoogle(env, sealed, which))
      ? "revoked"
      : "revoke_failed"
    : "none";

/**
 * The directory disconnect: POST R.directoryDisconnect and DELETE
 * R.directory (an interactive org owner session), and the platform's
 * install-delete job (cron.ts DIRECTORY_DISCONNECT_CRON, actor system).
 * 1. Revokes the live grant at Google, and a pending one on another account,
 *    best effort: a failure is audited (revoke_failed) and logged.
 * 2. One batch: the directory.disconnect audit row (gated, so a racing
 *    disconnect writes one) and the wipe of every directory_state key. The
 *    wipe returns what it deleted: a token committed after step 1 read it (a
 *    consent callback racing it) is revoked then (audited revoke_late), so
 *    no live grant is left behind.
 * 3. Resets DirectorySync (retried once): its next alarm clears its state
 *    and, with no binding, calls Google no more.
 * 4. Emails every active owner (the sync alert path).
 * During customer_mismatch, sync.state stays as a tombstone (wipeState):
 * synced users stay denied. Only an owner's break-glass reconnect and
 * confirm lifts it (a new binding; its resetSync clears health).
 * Memberships stay as they are (frozen): directory_members, sync
 * space_members, restricted_sync, org-group roles and bound identities are
 * not touched. Nothing connected: a no-op (no revoke, audit, reset or email).
 * `retry` (the system job): a failed revoke (live or pending) keeps every
 * key, audits directory.disconnect outcome revoke_failed and throws
 * DisconnectRetry, so the platform retries. A token row step 1 did not read
 * (a late consent) blocks the step 2 batch instead of a revoke_late: nothing
 * is deleted, one late_consent_kept row is audited, DisconnectRetry; the
 * next run revokes it. Google's "already invalid"
 * answer counts as revoked (direct.ts, the broker), so a dead grant ends.
 */
export async function disconnectDirectory(
  env: Env,
  actor: AuditActor,
  o: { showProblem: boolean; retry?: boolean },
): Promise<SyncStatus> {
  const [live, pend, sub, p] = await Promise.all([
    readBinding(env, "live"),
    readBinding(env, "pending"),
    liveSub(env),
    readPending(env),
  ]);
  if (!live.binding && !live.sealed && !pend.binding && !pend.sealed && !p)
    return directoryStatus(env, o);
  const revoked = await revokeOutcome(env, live.sealed, "live");
  // The same Google account as the live token: one grant, revoked above.
  const samePending = !!live.sealed && !!p?.s && p.s === sub;
  const pending = samePending
    ? "none"
    : await revokeOutcome(env, pend.sealed, "pending");
  if (o.retry && (revoked === "revoke_failed" || pending === "revoke_failed")) {
    // The grant may still be live at Google: keep everything for the retry.
    await audit(env, "directory.disconnect", AUDIT_TARGET, actor, {
      detail: {
        outcome: "revoke_failed",
        revoke: revoked,
        ...(pending !== "none" ? { pendingRevoke: pending } : {}),
      },
    })
      .run()
      .catch((e) => logWarn("directory_revoke_audit", e));
    logInfo("directory_disconnect", { revoke: revoked, pending, kept: true });
    throw new DisconnectRetry();
  }
  const [owners, tomb] = await Promise.all([
    ownerEmails(env),
    readSyncState(env),
  ]);
  // The system job: a token row other than the ones read above (a consent
  // landing after the reads: a new key, or a new value under a read key)
  // blocks the whole batch (one transaction), so the job never resolves
  // with a grant it did not revoke. The interactive path revokes it late.
  const guard = o.retry ? unseenTokens([live.sealed, pend.sealed]) : undefined;
  const [blocked, ...out] = await env.DB.batch([
    env.DB.prepare(`select ${guard ? `not ${guard.sql}` : "0"} as late`).bind(
      ...(guard?.args ?? []),
    ),
    audit(env, "directory.disconnect", AUDIT_TARGET, actor, {
      detail: {
        outcome: "disconnected",
        revoke: revoked,
        ...(pending !== "none" ? { pendingRevoke: pending } : {}),
        ...(tomb === MISMATCH_TOMBSTONE ? { mismatchKept: true } : {}),
        notified: owners.length,
      },
      when: {
        sql: guard ? `${CONNECTED} and ${guard.sql}` : CONNECTED,
        args: [...CONNECTED_KEYS, ...(guard?.args ?? [])],
      },
    }),
    // During customer_mismatch: the old Workspace is remembered first.
    keepPrior(env, guard),
    wipeState(env, guard),
  ]);
  if ((blocked?.results?.[0] as { late?: number } | undefined)?.late) {
    await audit(env, "directory.disconnect", AUDIT_TARGET, actor, {
      detail: { outcome: "late_consent_kept" },
    })
      .run()
      .catch((e) => logWarn("directory_revoke_audit", e));
    logInfo("directory_disconnect", { revoke: revoked, pending, late: true });
    throw new DisconnectRetry();
  }
  const won = (out[0]?.meta.changes ?? 0) > 0;
  // Tokens the wipe removed that step 1 never saw, by the grant they were.
  const seen = new Set([live.sealed, pend.sealed]);
  const late = ((out[2]?.results ?? []) as { key: string; value: string }[])
    .filter(
      (r) =>
        (r.key === K.refresh || r.key === K.pendingRefresh) &&
        !seen.has(r.value),
    )
    .map((r) => ({
      sealed: r.value,
      token: r.key === K.refresh ? ("live" as const) : ("pending" as const),
    }));
  for (const { sealed, token } of late) {
    const r = await revokeOutcome(env, sealed, token);
    logInfo("directory_disconnect_late", { token, revoke: r });
    await audit(env, "directory.disconnect", AUDIT_TARGET, actor, {
      detail: { outcome: "revoke_late", token, revoke: r },
    })
      .run()
      .catch((e) => logWarn("directory_revoke_audit", e));
  }
  logInfo("directory_disconnect", { revoke: revoked, pending, won });
  await resetSync(env);
  if (won)
    await alertOwners(env, "disconnected", owners).catch((e) =>
      logWarn("directory_disconnect_alert", e),
    );
  return directoryStatus(env, o);
}

/**
 * GET R.directory until T13's DirectorySync serves it. With no transport,
 * mode is "off" and, with `showProblem` (the org owner: directory.manage),
 * lastError carries the configuration problem. An expired pending
 * confirmation is dropped first (lazy expiry).
 */
export async function directoryStatus(
  env: Env,
  o: { showProblem: boolean },
): Promise<SyncStatus> {
  await expirePending(env);
  const t = directoryTransport(env);
  const mode = t.kind === "none" ? "off" : directoryMode(env);
  const [{ binding }, pending, health, tomb, prior, next] = await Promise.all([
    readBinding(env),
    readPending(env),
    readHealth(env),
    readSyncState(env),
    readPrior(env),
    readBinding(env, "pending"),
  ]);
  // A consent for another Workspace than the one a disconnect during
  // customer_mismatch removed: the confirm step says so.
  const change =
    pending &&
    prior &&
    next.binding &&
    next.binding.customerId !== prior.customerId
      ? {
          previous: prior,
          next: {
            customerId: next.binding.customerId,
            domain: next.binding.domain,
          },
        }
      : null;
  // T13: DirectorySync's health while a live binding exists.
  const h = healthFields(binding ? health : NEVER);
  return {
    mode,
    binding,
    healthy: mode === "off" ? null : h.healthy,
    state: pending
      ? "pending_confirm"
      : binding
        ? health.state
        : // Disconnected during a mismatch: synced users stay denied.
          tomb === MISMATCH_TOMBSTONE
          ? "customer_mismatch"
          : "never",
    unhealthySince: h.unhealthySince,
    lastSuccessAt: h.lastSuccessAt,
    lastError:
      t.kind === "none" && o.showProblem
        ? { at: new Date().toISOString(), message: t.problem }
        : h.lastError,
    nextRunAt: h.nextRunAt,
    staleAt: h.staleAt,
    alertedAt: h.alertedAt,
    customerMismatch: h.customerMismatch,
    held: h.held,
    pendingCount: pending ? pending.count : null,
    pendingCountCapped: pending ? pending.capped : false,
    pendingExpiresAt: pending ? new Date(pending.exp).toISOString() : null,
    pendingCustomerChange: change,
  };
}
