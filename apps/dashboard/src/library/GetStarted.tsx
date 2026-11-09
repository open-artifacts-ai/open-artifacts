import { Button } from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  BUS_POLL_MS,
  qk,
  useMembers,
  useOAuthClients,
  useTokens,
} from "../api/queries";
import { useMe } from "../auth/useMe";
import { AgentSetupBody } from "../settings/AgentSetupCard";
import { AppLink } from "./AppLink";

const hideKey = (userId: string) => `oa.getStarted.hidden.${userId}`;
const readHidden = (userId: string) => {
  try {
    return localStorage.getItem(hideKey(userId)) === "1";
  } catch {
    return false;
  }
};

const dot =
  "grid size-5 flex-none place-items-center rounded-full border-[1.5px] text-[length:var(--oa-text-xs)] font-semibold";

function Step({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: "done" | "cur" | "todo";
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li
      data-state={state}
      className="grid grid-cols-[20px_1fr] gap-x-[var(--oa-space-3)] gap-y-[var(--oa-space-1)] border-t border-border py-[var(--oa-space-3)]"
    >
      <span
        className={`${dot} ${
          state === "done"
            ? "border-[var(--oa-ok,#157a3a)] bg-[var(--oa-ok,#157a3a)] text-white"
            : state === "cur"
              ? "border-primary text-primary"
              : "border-border text-muted-foreground"
        }`}
        aria-hidden
      >
        {state === "done" ? "✓" : n}
      </span>
      <div
        className={`font-semibold ${state === "done" ? "text-muted-foreground line-through" : ""}`}
      >
        {title}
        {state === "done" && <span className="sr-only"> (done)</span>}
      </div>
      <div className="col-start-2 grid gap-[var(--oa-space-2)] text-[length:var(--oa-text-sm)] text-[var(--oa-text-2)]">
        {children}
      </div>
    </li>
  );
}

const Waiting = ({ children }: { children: string }) => (
  <p
    role="status"
    className="m-0 text-[length:var(--oa-text-xs)] text-muted-foreground"
  >
    {children}
  </p>
);

/**
 * The first-run "Get started" checklist above an empty Library (Design,
 * self-serve gaps 1A). The instance owner only, until every step is done or
 * they hide it; invited members get the plain Library. Each step ticks from
 * the server's record of the event: a connection (token or OAuth grant), an
 * artifact, an invited member. Hide is remembered in this browser.
 */
export function GetStarted({
  hasArtifacts,
  loaded,
}: {
  hasArtifacts: boolean;
  loaded: boolean;
}) {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const owner = me?.user.role === "owner";
  const userId = me?.user.id ?? "";
  const [hidden, setHidden] = useState(() => readHidden(userId));
  useEffect(() => setHidden(readHidden(userId)), [userId]);
  const live = owner && !hidden;
  const tokens = useTokens(live);
  const clients = useOAuthClients(live);
  const members = useMembers(undefined, live);
  const connected =
    (tokens.data?.length ?? 0) > 0 || (clients.data?.length ?? 0) > 0;
  const invited = (members.data ?? []).some(
    (m) => m.id !== userId && m.role !== "guest" && m.role !== "owner",
  );
  const ready =
    loaded && tokens.isSuccess && clients.isSuccess && members.isSuccess;
  const done = [connected, hasArtifacts, invited];
  const all = ready && done.every(Boolean);

  // Events happen elsewhere (an agent, another tab): re-read what is still
  // open, quietly, until it is done. Focus refetch covers returning to the tab.
  const qc = useQueryClient();
  useEffect(() => {
    if (!live || all) return;
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void qc.invalidateQueries({ queryKey: qk.tokens });
      void qc.invalidateQueries({ queryKey: qk.oauthClients });
      void qc.invalidateQueries({ queryKey: qk.members });
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
    }, BUS_POLL_MS);
    return () => clearInterval(t);
  }, [live, all, qc]);

  if (!live || !ready || all || !me?.instance.mcpUrl) return null;

  const hide = () => {
    try {
      localStorage.setItem(hideKey(userId), "1");
    } catch {}
    setHidden(true);
  };
  const count = done.filter(Boolean).length;
  const cur = done.indexOf(false);
  const st = (i: number) => (done[i] ? "done" : cur === i ? "cur" : "todo");
  // The trial line is about the Solo plan; self-hosted installs and other
  // plans have no such trial.
  const soloTrial = me.instance.billing?.tier === "solo";

  return (
    <section
      aria-labelledby="oa-get-started-h"
      className="rounded-lg border border-border bg-card p-[var(--oa-space-4)]"
    >
      <div className="mb-[var(--oa-space-2)] flex items-baseline gap-[var(--oa-space-2)]">
        <h2
          id="oa-get-started-h"
          className="m-0 text-[length:var(--oa-text-md)] font-semibold"
        >
          Get started
        </h2>
        <span className="text-[length:var(--oa-text-xs)] text-muted-foreground">
          {count} of 3
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-1 text-[length:var(--oa-text-xs)] text-muted-foreground"
          onClick={hide}
        >
          Hide
        </Button>
      </div>
      <ol className="m-0 list-none p-0">
        <Step n={1} state={st(0)} title="Connect your agent">
          {connected ? (
            <p className="m-0">Your agent is connected.</p>
          ) : (
            <>
              <AgentSetupBody intro="Paste this into Claude Code, Cursor or any AI agent. It signs in through your browser." />
              <Waiting>Waiting for your agent…</Waiting>
            </>
          )}
        </Step>
        <Step n={2} state={st(1)} title="Publish your first artifact">
          {hasArtifacts ? (
            <p className="m-0">Your first artifact is in your Library.</p>
          ) : (
            <>
              <p className="m-0">
                Ask it something like "summarize this repo as a page and publish
                it".
              </p>
              {connected && <Waiting>Waiting for the first artifact…</Waiting>}
            </>
          )}
        </Step>
        <Step
          n={3}
          state={st(2)}
          title={
            <>
              Invite your team{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </>
          }
        >
          {soloTrial && (
            <p className="m-0">
              Inviting someone starts a 14-day trial of Business. Your Solo plan
              stays as it is.
            </p>
          )}
          {!invited && (
            <div className="flex gap-[var(--oa-space-2)]">
              <Button asChild size="sm" className="h-[30px]">
                <AppLink href="/settings/members">Invite people</AppLink>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-[30px]"
                onClick={hide}
              >
                Not now
              </Button>
            </div>
          )}
        </Step>
      </ol>
    </section>
  );
}
