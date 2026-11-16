// #2632 (member onboarding, slice 1): the Library card for a member (not
// the owner, not a guest). The same five steps as the owner's, private to
// them, with "Hide". Hidden isn't done. Words are the design's ("The words
// on each screen", artifact wcL5Qbdtme52odvV), word for word.
import { Button } from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { fiveOf, mySteps, useOwnerName, withLocal } from "../api/myOnboarding";
import {
  BUS_POLL_MS,
  qk,
  useOnboarding,
  useSetOnboarding,
} from "../api/queries";
import { SETUP_STEPS, setupSteps } from "../api/setupSteps";
import { useMe } from "../auth/useMe";
import { AgentSetupBody } from "../settings/AgentSetupCard";
import { Step, Waiting } from "./steps";

/** The design's words for a member's steps. */
export const MEMBER_STEPS = {
  connect: "Connect your agent",
  connectHint: "Paste the line below into your agent.",
  name: "Name your agent",
  nameHint:
    "Your agent will suggest a name. It's what you'll type after @ in comments.",
  publish: "Publish your first artifact",
  publishHint:
    "Your agent publishes one during setup. It's private until you share it.",
  mention: "Mention your agent",
  mentionHint:
    "Open your first page, type @ in a comment and pick your agent. It replies in the thread.",
  ask: "Answer your agent's ask",
  askHint: "Your first page has a question from your agent. Pick an option.",
  stalled:
    'No reply yet. Your agent may not be listening. Ask it: "Check the bus."',
} as const;

/** A member: anyone signed in who is neither the owner nor a guest. */
export const isMember = (role: string | undefined) =>
  role === "member" || role === "admin";

export function MemberGetStarted() {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const member = isMember(me?.user.role);
  const onboarding = useOnboarding(member);
  const userId = me?.user.id;
  const setOnboarding = useSetOnboarding(userId ? { userId } : undefined);
  // A refused save (today's server) still holds for this session.
  const s = mySteps(withLocal(onboarding.data, userId));
  const five = fiveOf(s);
  const all = five.every(Boolean);
  // Nothing shows until the server has said the card is still open.
  const live = member && onboarding.isSuccess && !s.hidden && !s.completed;

  // Five of five: the server keeps that, so the card stays gone.
  const { mutate: save } = setOnboarding;
  useEffect(() => {
    if (live && all) save({ completed: true });
  }, [live, all, save]);

  // Steps happen elsewhere (an agent, another tab): re-read until done.
  const qc = useQueryClient();
  useEffect(() => {
    if (!live || all) return;
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void qc.invalidateQueries({ queryKey: qk.onboarding });
    }, BUS_POLL_MS);
    return () => clearInterval(t);
  }, [live, all, qc]);

  if (!live || all || !me?.instance.mcpUrl) return null;

  // Per person (#2632): hidden isn't done, so `completed` stays as it is.
  const hide = () => save({ dismissed: true });
  const o = onboarding.data;
  const nm = o?.agentName || "your agent";
  // The one count (packages/shared setupSteps): card, Welcome and Members agree.
  const { done: count, stalled } = setupSteps(o);
  const cur = stalled ? SETUP_STEPS.indexOf(stalled) : -1;
  const st = (i: number) => (five[i] ? "done" : cur === i ? "cur" : "todo");

  return (
    <section
      aria-labelledby="oa-get-started-h"
      data-member=""
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
          {count} of 5
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
        <Step n={1} state={st(0)} title={MEMBER_STEPS.connect}>
          {s.connected ? (
            <p className="m-0">Agent connected</p>
          ) : (
            <>
              <AgentSetupBody intro={MEMBER_STEPS.connectHint} />
              <Waiting>Waiting for your agent…</Waiting>
            </>
          )}
        </Step>
        <Step n={2} state={st(1)} title={MEMBER_STEPS.name}>
          <p className="m-0">
            {s.named ? `Named: ${nm}` : MEMBER_STEPS.nameHint}
          </p>
        </Step>
        <Step n={3} state={st(2)} title={MEMBER_STEPS.publish}>
          <p className="m-0">
            {s.published
              ? `Published: ${o?.firstArtifact?.title ?? "your first artifact"}`
              : MEMBER_STEPS.publishHint}
          </p>
        </Step>
        <Step n={4} state={st(3)} title={MEMBER_STEPS.mention}>
          {s.replied ? (
            <p className="m-0">{o?.agentName || "Your agent"} replied</p>
          ) : (
            <>
              <p className="m-0">{MEMBER_STEPS.mentionHint}</p>
              {o?.mentionStalled && <Waiting>{MEMBER_STEPS.stalled}</Waiting>}
            </>
          )}
        </Step>
        <Step n={5} state={st(4)} title={MEMBER_STEPS.ask}>
          <p className="m-0">
            {s.answered ? "Answered" : MEMBER_STEPS.askHint}
          </p>
        </Step>
      </ol>
    </section>
  );
}

/**
 * The design's line for a guest, where a member would publish. {owner} is
 * the instance owner's name (PROVISIONAL, api/myOnboarding.ts).
 */
export const guestPublish = (owner: string) =>
  `Guests can read and comment. To publish, ask ${owner} to make you a member.`;
/** OA Product (#2632): the owner's name isn't known. */
export const OWNER_UNKNOWN = "an owner";

export function GuestPublishNote() {
  const name = useOwnerName(true);
  const owner = name.data || OWNER_UNKNOWN;
  if (name.isPending) return null;
  return (
    <p
      data-guest-publish=""
      className="m-0 max-w-[46ch] text-[length:var(--oa-text-sm)] text-muted-foreground"
    >
      {guestPublish(owner)}
    </p>
  );
}
