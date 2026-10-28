import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditCredKind } from "@oa/shared";

/**
 * The credential behind a request (#803), as audit rows record it: its kind
 * and its id (a session's issue key, a PAT id, an OAuth grant id). Never the
 * token or any secret.
 */
export type Cred = { kind: AuditCredKind; id: string | null };

/**
 * One slot per request. The app's first middleware opens it (withCredScope)
 * and the session read fills it once (setCred); /mcp opens a sealed one with
 * the PAT or grant already in it (withCred). AsyncLocalStorage carries the
 * slot through every await and into waitUntil work started inside it, so work
 * that outlives the request still sees that request's own slot, never a later
 * one's. Outside any slot (cron, alarms, Durable Objects) there is none.
 */
type Slot = { cred: Cred | null; sealed: boolean };
const store = new AsyncLocalStorage<Slot>();

/** Runs `f` with a fresh, empty slot for this request. */
export function withCredScope<T>(f: () => T): T {
  return store.run({ cred: null, sealed: false }, f);
}

/** Runs `f` with `cred` fixed for its whole scope (a later setCred is ignored). */
export function withCred<T>(cred: Cred, f: () => T): T {
  return store.run({ cred, sealed: true }, f);
}

/**
 * Runs `f` with no credential, whatever the caller had: a Durable Object's
 * entry points, so an RPC from a request never lends it that request's
 * credential (a row written there passes its own, or records none).
 */
export function withoutCred<T>(f: () => T): T {
  return store.run({ cred: null, sealed: true }, f);
}

/** Records this request's credential, once; a no-op outside a slot or once set. */
export function setCred(cred: Cred): void {
  const s = store.getStore();
  if (s && !s.sealed && s.cred === null) s.cred = cred;
}

/** This request's credential, or null (anonymous, or no request at all). */
export function currentCred(): Cred | null {
  return store.getStore()?.cred ?? null;
}

/**
 * A cookie session's id. Sessions are stateless signed cookies with no row,
 * so the id is the provider and issue time (ms): unique per sign-in for the
 * user, and the same key break-glass audits by. Never the cookie or its MAC.
 */
export const sessionCredId = (s: { p: string; iat: number }): string =>
  `${s.p}:${s.iat}`;
