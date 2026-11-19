import { applicableSteps, SETUP_STEPS } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { BUS_LINE } from "../api/myOnboarding";
import {
  BUS_POLL_MS,
  qk,
  useMembers,
  useOAuthClients,
  useOnboarding,
  useSetOnboarding,
  useTokens,
} from "../api/queries";
import { useMe } from "../auth/useMe";
import { AgentSetupBody } from "../settings/AgentSetupCard";
import { AppLink } from "./AppLink";
import { Step, Waiting } from "./steps";

/**
 * The first-run "Get started" checklist above an empty Library (Design,
 * self-serve gaps 1A). The instance owner only, until every step is done or
 * they hide it; invited members get the plain Library. Each step ticks from
 * the server's record of the event: a connection (token or OAuth grant), an
 * artifact, an invited member. Hide, and having finished, live on the server
 * (R.onboarding), so every browser agrees and a finished list stays gone.
 */
export function GetStarted({
  ownIds,
  loaded,
}: {
  /** Ids of the own artifacts on the Library pages already loaded. */
  ownIds: string[];
  loaded: boolean;
}) {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const owner = me?.user.role === "owner";
  const userId = me?.user.id ?? "";
  const onboarding = useOnboarding(owner);
  const setOnboarding = useSetOnboarding();
  const finished =
    onboarding.data?.dismissed === true || onboarding.data?.completed === true;
  // Nothing is fetched or shown until the server has said it is still open.
  const live = owner && onboarding.isSuccess && !finished;
  const tokens = useTokens(live);
  const clients = useOAuthClients(live);
  const members = useMembers(undefined, live);
  // The server says so even when the own artifact is past the loaded pages (#1832).
  // firstArtifact is the oldest own artifact that is not the seeded Welcome
  // (the server's hasArtifacts counts Welcome and the self-test page, so it
  // can't tick this). A server without it: hasArtifacts, else the loaded own
  // artifacts minus the Welcome.
  const o = onboarding.data;
  const hasArtifacts =
    o?.firstArtifact !== undefined
      ? o.firstArtifact !== null
      : (o?.hasArtifacts ?? ownIds.some((id) => id !== o?.welcomeId));
  const connected =
    (tokens.data?.length ?? 0) > 0 || (clients.data?.length ?? 0) > 0;
  const invited = (members.data ?? []).some(
    (m) => m.id !== userId && m.role !== "guest" && m.role !== "owner",
  );
  const ready =
    loaded && tokens.isSuccess && clients.isSuccess && members.isSuccess;
  // #2478: the five steps, then the optional invite. #2890: someone who never
  // connected the bus (chat-only) sees three: the bus-only two are hidden.
  const steps = applicableSteps(o?.busConnected);
  const bus = steps.includes("named");
  const named = o?.agentNamed === true;
  const replied = o?.mentionReplied === true;
  const answered = o?.askAnswered === true;
  const nm = o?.agentName || "your agent";
  const five = [connected, named, hasArtifacts, replied, answered];
  const shown = steps.map((s) => SETUP_STEPS.indexOf(s));
  const all = ready && shown.every((i) => five[i]) && invited;

  // Every step done: the server keeps that, so removing a member or a token
  // later never brings the list back. Not while the bus was never connected
  // (#2890): a Claude Code user can reach 3 of 3 before oa-bus first connects,
  // and a saved `completed` would hide Name and Mention for good.
  const { mutate: save } = setOnboarding;
  useEffect(() => {
    if (live && all && bus) save({ completed: true });
  }, [live, all, bus, save]);

  // Events happen elsewhere (an agent, another tab): re-read what is still
  // open, quietly, until it is done. Focus refetch covers returning to the tab.
  const qc = useQueryClient();
  useEffect(() => {
    // Without the bus, 3 of 3 keeps listening: connecting it brings two steps back.
    if (!live || (all && bus)) return;
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      // Only what is still open; the Library's pages refetch only while no
      // artifact exists yet.
      if (!connected) {
        void qc.invalidateQueries({ queryKey: qk.tokens });
        void qc.invalidateQueries({ queryKey: qk.oauthClients });
      }
      if (!invited) void qc.invalidateQueries({ queryKey: qk.members });
      if (!hasArtifacts) void qc.invalidateQueries({ queryKey: ["artifacts"] });
      // Without the bus, keep reading: connecting it brings two steps back.
      if (!bus || !(hasArtifacts && answered && named && replied))
        void qc.invalidateQueries({ queryKey: qk.onboarding });
    }, BUS_POLL_MS);
    return () => clearInterval(t);
  }, [
    live,
    all,
    qc,
    connected,
    invited,
    hasArtifacts,
    bus,
    named,
    replied,
    answered,
  ]);

  if (!live || !ready || all || !me?.instance.mcpUrl) return null;

  const hide = () => save({ dismissed: true });
  const count = shown.filter((i) => five[i]).length;
  // Index 5 is the optional invite step.
  const cur = shown.find((i) => !five[i]) ?? (invited ? -1 : 5);
  const st = (i: number) =>
    (i === 5 ? invited : five[i]) ? "done" : cur === i ? "cur" : "todo";
  const no = (i: number) => shown.indexOf(i) + 1;
  // The trial line is true only when the server would start the Business
  // trial on an invite (plan.trialEligible): Solo or free, no trial used yet,
  // not read-only. Self-hosted installs have no billing.
  const b = me.instance.billing;
  const soloTrial =
    !!b &&
    (b.tier === "solo" || b.tier === "free") &&
    b.trialEndsAt === null &&
    !b.readOnly;
  const keepsSolo = b?.tier === "solo";

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
          {count} of {shown.length}
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
        <Step n={no(0)} state={st(0)} title="Connect your agent">
          {connected ? (
            <p className="m-0">Agent connected</p>
          ) : (
            <>
              <AgentSetupBody intro="Paste this into Claude Code, Cursor or any AI agent. It logs in through your browser." />
              <Waiting>Waiting for your agent…</Waiting>
            </>
          )}
        </Step>
        {bus && (
          <Step n={no(1)} state={st(1)} title="Name your agent">
            {named ? (
              <p className="m-0">Named: {nm}</p>
            ) : (
              <p className="m-0">
                Your agent will suggest a name. It's what you'll type after @ in
                comments.
              </p>
            )}
          </Step>
        )}
        <Step n={no(2)} state={st(2)} title="Publish your first artifact">
          {hasArtifacts ? (
            <p className="m-0">
              Published: {o?.firstArtifact?.title ?? "your first artifact"}
            </p>
          ) : (
            <>
              <p className="m-0">
                Ask your agent: "Publish a page about what you're working on."
              </p>
              {connected && <Waiting>Waiting for the first artifact…</Waiting>}
            </>
          )}
        </Step>
        {bus && (
          <Step n={no(3)} state={st(3)} title="Mention your agent">
            {replied ? (
              <p className="m-0">{o?.agentName || "Your agent"} replied</p>
            ) : (
              <>
                <p className="m-0">
                  Open your first page, type @ in a comment and pick {nm}. It
                  replies in the thread.
                </p>
                {o?.mentionStalled && (
                  <Waiting>
                    No reply yet. Your agent may not be listening. Ask it:
                    "Check the bus."
                  </Waiting>
                )}
              </>
            )}
          </Step>
        )}
        <Step n={no(4)} state={st(4)} title="Answer your agent's ask">
          {answered ? (
            <p className="m-0">Answered</p>
          ) : (
            <p className="m-0">
              Your first page has a question from {nm}. Pick an option.
            </p>
          )}
        </Step>
        <Step
          state={st(5)}
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
              Inviting someone starts a 30-day Team trial.
              {keepsSolo && " Your Solo plan stays as it is."}
            </p>
          )}
          {!invited && cur === 5 && (
            <div className="flex gap-[var(--oa-space-2)]">
              <Button
                asChild
                size="sm"
                className="h-[30px] bg-[var(--oa-accent)] text-[var(--oa-accent-text)] hover:bg-[var(--oa-accent-fg)]"
              >
                <AppLink href="/settings/members?invite=1">
                  Invite people
                </AppLink>
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
      {!bus && (
        <p
          data-bus-line=""
          className="m-0 mt-[var(--oa-space-2)] text-[length:var(--oa-text-xs)] text-muted-foreground"
        >
          {BUS_LINE}
        </p>
      )}
    </section>
  );
}
