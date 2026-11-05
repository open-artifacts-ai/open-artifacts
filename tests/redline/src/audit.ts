import { randomBytes } from "node:crypto";
import {
  HttpError,
  hook,
  parseJson,
  readBody,
  sessionCred,
  withCred,
} from "./http.ts";
import { localD1Count } from "./local-pair.ts";
import type { Target } from "./targets.ts";

// "A hook call is audited". A fresh member (unique per run, so an older row
// can't satisfy the check) is created through the session hook; then its
// test_hook.session row must exist. Local mode reads D1. Staging reads the
// read-only POST /__test/audit hook (Backend #642): any 404 there (hook
// absent, an older server) is unproven-live, never pass.

export const AUDIT_HOOK = "/__test/audit";
/** Clock skew allowance between this runner and the install. */
const SKEW_MS = 5 * 60_000;

export type AuditResult =
  | { level: "pass"; via: "d1" | "hook" }
  | { level: "unproven-live"; reason: string };

interface AuditEvent {
  action?: unknown;
  at?: unknown;
  actorId?: unknown;
  targetId?: unknown;
}

/** Calls the session hook for a fresh member and returns its user id. */
async function freshHookUser(t: Target): Promise<string> {
  const email = `redline-audit-${randomBytes(6).toString("hex")}@${t.testDomain}`;
  const cookie = await sessionCred(t, email, "member");
  const res = await fetch(`${t.app}/api/v1/me`, withCred(cookie));
  const text = await readBody(res);
  if (res.status !== 200)
    throw new HttpError(`${t.name} audit user /api/v1/me`, res, text);
  const id = (
    parseJson(res, text, `${t.name} audit user`) as { user?: { id?: unknown } }
  ).user?.id;
  if (typeof id !== "string" || !id)
    throw new Error(`${t.name} audit user: no id`);
  return id;
}

export async function auditCheck(t: Target): Promise<AuditResult> {
  const since = Math.max(0, Date.now() - SKEW_MS);
  const userId = await freshHookUser(t);
  if (t.local) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId))
      throw new Error("audit: unexpected user id shape");
    const n = localD1Count(
      t.local,
      `select count(*) as n from audit_events where action = 'test_hook.session' and actor_kind = 'test_hook' and actor_id = '${userId}'`,
    );
    if (n < 1)
      throw new Error(`${t.name}: no test_hook.session row for the hook call`);
    return { level: "pass", via: "d1" };
  }
  let out: unknown;
  try {
    out = await hook(t, AUDIT_HOOK, { since });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404)
      return {
        level: "unproven-live",
        reason: "the audit hook answered 404 (absent or older server)",
      };
    throw e;
  }
  const events = (out as { events?: unknown } | null)?.events;
  if (!Array.isArray(events))
    throw new Error(`${t.name} audit hook: no events array`);
  const hit = (events as AuditEvent[]).some(
    (e) => e?.action === "test_hook.session" && e.actorId === userId,
  );
  if (!hit)
    throw new Error(
      `${t.name}: the session hook call has no test_hook.session audit row`,
    );
  return { level: "pass", via: "hook" };
}
