import { type Me, R } from "@oa/shared";
import { useLayoutEffect, useRef, useState } from "react";
import type { InstanceDirectory, SyncState } from "../api/contract";
import { AppLink } from "../library/AppLink";
import { Notice } from "./Notice";

const DISMISSED_KEY = "oa.syncBanner.dismissed";
const DAY_MS = 24 * 3600_000;

const read = () => {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
};

type Failing = Exclude<SyncState, "ok">;
type Stage = "warning" | "danger";

/** Failing for 24 hours or more: sign-ins are capped at 24 hours from then. */
const dayOld = (since: string | null) =>
  !!since && Date.now() - Date.parse(since) >= DAY_MS;

/** backoff and never are a warning for their first 24 hours; the rest need a person. */
const stageOf = (state: Failing, since: string | null): Stage =>
  (state !== "backoff" && state !== "never") || dayOld(since)
    ? "danger"
    : "warning";

const time = (d: Date) =>
  d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const day = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
/** " at 2:10 PM" today, else " Oct 20 at 2:10 PM" (the Directory page's when() rule). */
const stoppedAt = (since: string | null) => {
  if (!since) return "";
  const d = new Date(since);
  const today = d.toDateString() === new Date().toDateString();
  return today ? ` at ${time(d)}` : ` ${day(d)} at ${time(d)}`;
};

const FROZEN =
  "Access is frozen as of then: changes in Google, including people who left, won't apply here until";
/** Why sync stopped, and the owner's fix, for the states only a reconnect fixes. */
const STOPPED: Partial<Record<Failing, [why: string, fix: string]>> = {
  auth_failed: [
    "our connection was revoked or expired.",
    "Reconnect with a Google super admin.",
  ],
  scope_missing: [
    "a permission we need was removed in Google.",
    "Reconnect and allow every permission.",
  ],
  customer_mismatch: [
    "the connection points to a different Google Workspace.",
    // Design's copy names the bound domain; Me.instance.directory doesn't carry it.
    "Reconnect with your company's Google Workspace.",
  ],
};

const copy = (state: Failing, since: string | null, owner: boolean) => {
  if (state === "never")
    return {
      title: "The first Google sync hasn't finished",
      body: "We keep trying. Group access starts once it does.",
    };
  const stopped = STOPPED[state];
  if (!stopped)
    return {
      title: "Google directory sync is failing",
      body: `Google sync stopped${stoppedAt(since)} and we keep retrying. ${FROZEN} sync recovers.`,
    };
  const [why, fix] = stopped;
  return {
    title: "Google directory sync stopped",
    body: `Google sync stopped${stoppedAt(since)}: ${why} ${FROZEN} you reconnect.${owner ? ` ${fix}` : ""}`,
    reconnect: true,
  };
};
/**
 * Design's D13 B: owners and admins, once sync has been unhealthy for an hour
 * (`directory.banner`). Dismissing hides the current state and stage in this
 * browser; the owner can't dismiss the danger stage.
 */
export function SyncBanner({
  me,
  className = "",
}: {
  // From the caller: a fresh /me observer here would refetch an errored /me.
  me: Me | null;
  /** The page's content column, so the banner's edges line up with it. */
  className?: string;
}) {
  const d = me?.instance.directory ?? null;
  const role = me?.user.role;
  const [dismissed, setDismissed] = useState(read);
  const ref = useRef<HTMLDivElement>(null);
  const admin = role === "owner" || role === "admin";
  const state = d?.banner && admin && d.state !== "ok" ? d.state : null;
  const stage = state && stageOf(state, d?.unhealthySince ?? null);
  const key = `${state}:${stage}`;
  const shown = !!state && dismissed !== key;
  // Banner names nothing itself; its live region needs "Directory sync".
  useLayoutEffect(() => {
    ref.current
      ?.querySelector("[role=status], [role=alert]")
      ?.setAttribute("aria-label", "Directory sync");
  });
  if (!state || !stage || !shown || !d) return null;
  const owner = role === "owner";
  const c = copy(state, d.unhealthySince, owner);
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, key);
    } catch {}
    setDismissed(key);
  };
  return (
    <div ref={ref} className={`oa-sync-banner ${className}`}>
      <Notice
        tone={stage}
        title={c.title}
        onDismiss={owner && stage === "danger" ? undefined : dismiss}
      >
        <p>
          {c.body}
          {dayOld(d.unhealthySince) && " Sign-ins now last at most 24 hours."}
          {!owner && " The owner can fix it."}
        </p>
        <div className="oa-cpu-acts">
          {owner && c.reconnect && (
            <a className="oa-btn oa-sm oa-primary" href={R.directoryConnect}>
              Reconnect
            </a>
          )}
          {owner ? (
            <AppLink
              className={`oa-btn oa-sm ${c.reconnect ? "" : "oa-primary"}`}
              href="/settings/directory"
            >
              Open directory settings
            </AppLink>
          ) : (
            <AppLink className="oa-btn oa-sm" href="/settings/directory">
              View status
            </AppLink>
          )}
        </div>
        {d.tokensUnverified && (
          <div className="oa-sync-tokens">
            <strong>Agent tokens aren't being re-checked</strong>
            <p>
              Tokens and connected AI agents keep working for people Google has
              removed. If someone left, remove them in{" "}
              <AppLink href="/settings/members">Members</AppLink>.
            </p>
          </div>
        )}
      </Notice>
    </div>
  );
}

/**
 * The dot's tone while sync needs an owner's or admin's attention (any state
 * but ok, or a held sweep), else null. Members and guests get null: the
 * server sends them no state and no held count.
 */
export function syncDot(me: Me | null): Stage | null {
  const d: InstanceDirectory | null = me?.instance.directory ?? null;
  const role = me?.user.role;
  if (!d || (role !== "owner" && role !== "admin")) return null;
  if (d.state && d.state !== "ok") return stageOf(d.state, d.unhealthySince);
  return d.heldSweeps > 0 ? "warning" : null;
}

/** Design's attention dot; decorative, so its link carries ATTENTION (AttentionDot.tsx) in its name. */
export function SyncDot({
  tone,
  small = false,
  className = "",
}: {
  tone: Stage;
  /** 6px on a tab; 8px in the sidebar. */
  small?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`block flex-none rounded-full ${small ? "size-1.5" : "size-2"} ${className}`}
      style={{ background: `var(--oa-${tone})` }}
    />
  );
}
