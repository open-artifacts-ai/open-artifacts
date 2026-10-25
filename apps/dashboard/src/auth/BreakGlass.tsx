// Directory break-glass (Backend #597/#599): GET R.me answers 401
// break_glass_required { fresh } for the org owner locked out by a
// customer_mismatch. Instead of signing out, a centered card: stale, a forced
// Google sign-in (AUTH.loginGoogle?reauth=1); fresh, a minimal directory
// screen in the same card. /me stays 401 throughout, so the screen has no app
// shell and calls only R.directory, R.directoryConfirm and R.directoryCancel
// (R.directoryConnect is a full-page navigation to Google).
import { AUTH, R } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { ApiClientError, api } from "../api/client";
import { type SyncStatus, SyncStatusSchema } from "../api/contract";
import { qk } from "../api/queries";
import { metaInstanceName } from "../layout/useDocumentTitle";
import { EdgePanel } from "../pages/Edge";
import { connectCopy, expiry, people } from "../settings/Directory";
import { errorText, muted } from "../settings/ui";
import { safeNext } from "./safeNext";
import { useSignOut } from "./signOut";

/**
 * Every string, in one place: Design's option B (the user's pick, with the
 * corrected audit note). The directory steps reuse the Directory page's copy
 * where it has some.
 */
export const BREAK_GLASS_COPY = {
  title: "Sign-in is paused for your team",
  body: (instance: string) =>
    `Your Google directory now belongs to a different Google Workspace than the one ${instance} was connected to. To protect your data, people who sign in through it can't sign in until you reconnect the directory.`,
  reauth: "Sign in with Google again",
  reauthNote: "To keep this safe, sign in again first.",
  open: "Open directory settings",
  signOut: "Sign out",
  audit:
    "You can only use directory settings here. Each use is recorded in the audit log, and we email you when this access starts.",
  // The minimal directory screen.
  reconnectTitle: "Reconnect your Google directory",
  reconnectBody: (domain: string | null) =>
    `Reconnect with ${domain ? `the ${domain}` : "your organization's"} Google Workspace, as a super admin. Nobody is added until you confirm.`,
  reconnect: "Reconnect Google Workspace",
  opening: "Opening Google…",
  connectFailed: "Couldn't connect Google Workspace.",
  cancelled: "Not connected. Nobody was added.",
  expired:
    "This confirmation expired after 24 hours. Connect again to see the current count.",
  doneTitle: "Directory reconnected",
  doneBody: "Your team can sign in with Google again.",
  continue: (instance: string) => `Continue to ${instance}`,
  loadFailed: "Couldn't load the directory.",
  retry: "Try again",
  confirmFailed: "Couldn't add the people. Try again.",
  cancelFailed: "Couldn't cancel the connection. Try again.",
};
const C = BREAK_GLASS_COPY;

/** The forced Google sign-in, back to `next` (same-origin only). */
export const reauthHref = (next: string) =>
  `${AUTH.loginGoogle}?reauth=1&next=${encodeURIComponent(safeNext(next))}`;

const isReauth = (e: unknown) =>
  e instanceof ApiClientError && e.code === "reauth_required";

const DIRECTORY = /^\/settings\/directory\/?$/i;

/** The card. Back from Google (on /settings/directory) it opens the directory screen. */
export function BreakGlass({
  fresh,
  path,
  search,
}: {
  fresh: boolean;
  path: string;
  /** The location's search string ("?error=…"), kept across the sign-in. */
  search: string;
}) {
  // Not useInstanceName: a second /me observer would refetch the failed /me on mount.
  const name = metaInstanceName();
  useEffect(() => {
    document.title = `Sign-in is paused · ${name}`;
  }, [name]);
  const [open, setOpen] = useState(fresh && DIRECTORY.test(path));
  // The fresh window (10 min) can lapse while the screen is open.
  const [lapsed, setLapsed] = useState(false);
  const here = path + search;
  if (fresh && open && !lapsed)
    return (
      <Minimal
        error={new URLSearchParams(search).get("error")}
        onLapsed={() => setLapsed(true)}
      />
    );
  return (
    <Step title={C.title}>
      <p>{C.body(name)}</p>
      {fresh && !lapsed ? (
        <Button className="w-full" onClick={() => setOpen(true)}>
          {C.open}
        </Button>
      ) : (
        <>
          <Button asChild className="w-full">
            <a href={reauthHref(here)}>{C.reauth}</a>
          </Button>
          <p className={muted}>{C.reauthNote}</p>
        </>
      )}
    </Step>
  );
}

/** One step of the card: content, then Sign out and the audit note. */
function Step({ title, children }: { title: string; children: ReactNode }) {
  const signOut = useSignOut();
  // `.oa-panel p` sets paragraph margins; the gaps here come from the grids.
  return (
    <EdgePanel>
      <h1>{title}</h1>
      <div className="grid gap-[var(--oa-space-3)] [&_p]:!m-0">{children}</div>
      <div className="mt-[var(--oa-space-4)] grid gap-[var(--oa-space-3)] [&_p]:!m-0">
        <Button variant="ghost" className="w-full" onClick={signOut}>
          {C.signOut}
        </Button>
        <p className={muted}>{C.audit}</p>
      </div>
    </EdgePanel>
  );
}

/** The connect link: a full-page navigation to Google consent. */
function Reconnect() {
  const [opening, setOpening] = useState(false);
  // Back from Google's consent page restores this page from the bfcache: reset.
  useEffect(() => {
    const reset = () => setOpening(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return (
    <Button asChild className="w-full">
      <a href={R.directoryConnect} onClick={() => setOpening(true)}>
        {opening ? C.opening : C.reconnect}
      </a>
    </Button>
  );
}

type Outcome = "cancelled" | "expired" | "done" | null;

/** Reconnect, confirm and cancel; nothing else, and never /me. */
function Minimal({
  error,
  onLapsed,
}: {
  /** `?error=` from the connect callback. */
  error: string | null;
  onLapsed: () => void;
}) {
  const name = metaInstanceName();
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome>(null);
  const status = useQuery({
    queryKey: qk.directory,
    queryFn: ({ signal }) => api.get(R.directory, SyncStatusSchema, signal),
  });
  // Not the shared hooks: those refetch /me when they settle.
  const onError = (e: unknown) => {
    if (!(e instanceof ApiClientError && e.status === 409)) return;
    setOutcome("expired");
    void qc.invalidateQueries({ queryKey: qk.directory });
  };
  const confirm = useMutation({
    mutationFn: () =>
      api.send("POST", R.directoryConfirm, undefined, SyncStatusSchema),
    onSuccess: (s: SyncStatus) => {
      qc.setQueryData(qk.directory, s);
      setOutcome("done");
    },
    onError,
  });
  const cancel = useMutation({
    mutationFn: () => api.send("POST", R.directoryCancel, undefined),
    onSuccess: () => {
      setOutcome("cancelled");
      void qc.invalidateQueries({ queryKey: qk.directory });
    },
    onError,
  });
  const lapsed = [status.error, confirm.error, cancel.error].some(isReauth);
  useEffect(() => {
    if (lapsed) onLapsed();
  }, [lapsed, onLapsed]);
  if (lapsed) return null;

  if (outcome === "done")
    return (
      <Step title={C.doneTitle}>
        <p>{C.doneBody}</p>
        <Button
          className="w-full"
          onClick={() => void qc.invalidateQueries({ queryKey: qk.me })}
        >
          {C.continue(name)}
        </Button>
      </Step>
    );

  const sync = status.data;
  if (!sync)
    return (
      <Step title={C.reconnectTitle}>
        {status.isError ? (
          <>
            <p role="alert" className={errorText}>
              {C.loadFailed}
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void status.refetch()}
            >
              {C.retry}
            </Button>
          </>
        ) : (
          <p aria-busy="true">Loading…</p>
        )}
      </Step>
    );

  const domain = sync.binding?.domain ?? null;
  if (sync.state === "pending_confirm" && outcome === null) {
    const capped = sync.pendingCountCapped;
    const n = sync.pendingCount ?? 0;
    const busy = confirm.isPending || cancel.isPending;
    const failed = confirm.isError
      ? C.confirmFailed
      : cancel.isError
        ? C.cancelFailed
        : null;
    return (
      <Step title={capped ? "Add 500+ people?" : `Add ${people(n)}?`}>
        <p>
          This adds {capped ? "more than 500 people" : people(n)}
          {domain ? ` from ${domain}` : ""} as{" "}
          {!capped && n === 1 ? "a member" : "members"}. They can sign in with
          Google right away.
        </p>
        {sync.pendingExpiresAt && (
          <p className={muted}>
            Confirm by {expiry(sync.pendingExpiresAt)}, or connect again.
          </p>
        )}
        {failed && (
          <p role="alert" className={errorText}>
            {failed}
          </p>
        )}
        <div className="grid gap-[var(--oa-space-2)]">
          <Button
            className="w-full"
            disabled={busy}
            aria-busy={confirm.isPending || undefined}
            onClick={() => confirm.mutate()}
          >
            {capped ? "Add people" : `Add ${people(n)}`}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => cancel.mutate()}
          >
            Cancel
          </Button>
        </div>
      </Step>
    );
  }

  const reason = error !== null ? connectCopy(error, domain) : null;
  return (
    <Step title={C.reconnectTitle}>
      {error !== null && (
        <div role="alert" className="grid gap-[var(--oa-space-1)]">
          <p className={`${errorText} font-medium`}>{C.connectFailed}</p>
          {reason && <p className={errorText}>{reason}</p>}
        </div>
      )}
      {outcome === "cancelled" && <p>{C.cancelled}</p>}
      {outcome === "expired" && (
        <p className="text-[var(--oa-warning)]">{C.expired}</p>
      )}
      <p>{C.reconnectBody(domain)}</p>
      <Reconnect />
    </Step>
  );
}
