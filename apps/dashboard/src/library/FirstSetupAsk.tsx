/**
 * #2577 (Design v8, "First setup"): one question, asked once, when a member has
 * connected their first agent on a team. It starts on "Only people I choose";
 * "Skip for now" keeps that. Never a wall: a card under Get started.
 * PROVISIONAL (#2577 s2): `listensAsked` and the teammates list.
 */
import { LISTEN_ADD_BATCH_MAX } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useState } from "react";
import { useAddListens, useSetAgentRequests } from "../api/agentAsks";
import { errorCopy } from "../api/errorCopy";
import { useOnboarding } from "../api/queries";
import {
  listensAskedOf,
  useMarkListensAsked,
  useMyTeammates,
} from "../api/teammates";
import { useMe } from "../auth/useMe";
import { endDate } from "../foryou/held";
import { toast } from "../layout/toast";
import { isMember } from "./MemberGetStarted";

export const FIRST_ASK = {
  title: "Let teammates ask your agents about pages they work on?",
  hint: "Your agents run on your computer. You can change this any time in Settings, Connections.",
  yes: "Yes, my colleagues",
  choose: "Only people I choose",
  chooseHint:
    "Anyone else's request waits for you: allow it once, or add them to your list.",
  no: "No",
  noHint: "Your agents only answer you.",
  skip: "Skip for now",
  next: "Continue",
} as const;

const DAYS = 90;
/** Names listed before "and N more". */
const SHOWN = 6;
const DAY = 24 * 3600_000;

type Pick = "yes" | "choose" | "no";

export function FirstSetupAsk() {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const member = isMember(me?.user.role);
  const onboarding = useOnboarding(member);
  const team = useMyTeammates(member);
  const asked = useMarkListensAsked();
  const add = useAddListens();
  const off = useSetAgentRequests();
  const [pick, setPick] = useState<Pick>("choose");
  const [step, setStep] = useState<"ask" | "confirm">("ask");
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = team.data?.members ?? [];
  const connected =
    (onboarding.data as { agentConnected?: boolean } | undefined)
      ?.agentConnected === true;
  // Only an explicit false asks; absent is an old server. Solo has nobody to ask.
  const show =
    member &&
    connected &&
    listensAskedOf(onboarding.data) === false &&
    people.length > 0;
  if (!show) return null;
  const team_name = me?.instance.name ?? "your team";
  const chosen = people.filter((p) => !skipped.has(p.id));
  const until = Date.now() + DAYS * DAY;

  const done = (title?: string) => {
    if (title) toast({ title, tone: "neutral" });
  };
  const markAsked = () =>
    asked.mutateAsync().catch(() => {
      // The answer is kept for this session; it is asked again next load.
    });
  const submitPick = async () => {
    if (pick === "yes") {
      setStep("confirm");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (pick === "no") await off.mutateAsync(false);
      await markAsked();
      done(
        pick === "no"
          ? "Your agents only answer you now. Change it in Settings, Connections."
          : undefined,
      );
    } catch (e) {
      setError(errorCopy(e, "Couldn't save that. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const addAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const ids = chosen.map((p) => p.id);
      for (let i = 0; i < ids.length; i += LISTEN_ADD_BATCH_MAX)
        await add.mutateAsync({
          memberIds: ids.slice(i, i + LISTEN_ADD_BATCH_MAX),
          scope: "all",
          until: DAYS,
          via: "first_setup",
        });
      await markAsked();
      done(
        `Added ${ids.length} ${ids.length === 1 ? "person" : "people"}. Their requests reach your agents without asking you.`,
      );
    } catch (e) {
      setError(errorCopy(e, "Couldn't add them. Nothing was changed."));
    } finally {
      setBusy(false);
    }
  };

  const CARD =
    "rounded-lg border border-border bg-card p-[var(--oa-space-4)] mb-[var(--oa-space-4)]";
  if (step === "confirm")
    return (
      <section
        data-first-setup=""
        aria-labelledby="oa-first-setup-h"
        className={CARD}
      >
        <h2
          id="oa-first-setup-h"
          className="m-0 text-[length:var(--oa-text-md)] font-semibold"
        >
          {people.length === 1
            ? "Add this person?"
            : `Add these ${people.length} people?`}
        </h2>
        <p className="mt-1 mb-2 text-[length:var(--oa-text-sm)] text-muted-foreground">
          All pages your agents work on, until {endDate(until)}.
        </p>
        <ul className="m-0 grid max-h-60 list-none gap-1 overflow-y-auto p-0">
          {(more ? people : people.slice(0, SHOWN)).map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 text-[length:var(--oa-text-sm)]">
                <input
                  type="checkbox"
                  checked={!skipped.has(p.id)}
                  onChange={(e) =>
                    setSkipped((cur) => {
                      const next = new Set(cur);
                      if (e.target.checked) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    })
                  }
                />
                <span
                  aria-hidden="true"
                  className="grid size-[22px] place-items-center rounded-full border border-border bg-muted text-[9.5px] font-semibold"
                >
                  {p.initials}
                </span>
                {p.name}
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-2 mb-0 text-[length:var(--oa-text-xs)] text-muted-foreground">
          {!more && people.length > SHOWN && (
            <>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-primary underline"
                onClick={() => setMore(true)}
              >
                and {people.length - SHOWN} more
              </button>
              {". "}
            </>
          )}
          Untick anyone. People outside your team aren't offered.
        </p>
        {error && (
          <p
            role="alert"
            className="mt-2 mb-0 text-[length:var(--oa-text-sm)] text-destructive"
          >
            {error}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setStep("ask")}
          >
            Back
          </Button>
          <Button
            size="sm"
            disabled={busy || chosen.length === 0}
            onClick={() => void addAll()}
          >
            {chosen.length === 1
              ? "Add 1 person"
              : `Add ${chosen.length} people`}
          </Button>
        </div>
      </section>
    );

  const opts: { id: Pick; label: string; hint: string }[] = [
    {
      id: "yes",
      label: FIRST_ASK.yes,
      hint: `The ${people.length} ${people.length === 1 ? "member" : "members"} of ${team_name} today, for ${DAYS} days. Not people who join later, and never people outside your team.`,
    },
    { id: "choose", label: FIRST_ASK.choose, hint: FIRST_ASK.chooseHint },
    { id: "no", label: FIRST_ASK.no, hint: FIRST_ASK.noHint },
  ];
  return (
    <section
      data-first-setup=""
      aria-labelledby="oa-first-setup-h"
      className={CARD}
    >
      <h2
        id="oa-first-setup-h"
        className="m-0 text-[length:var(--oa-text-md)] font-semibold"
      >
        {FIRST_ASK.title}
      </h2>
      <p className="mt-1 mb-2 text-[length:var(--oa-text-sm)] text-muted-foreground">
        {FIRST_ASK.hint}
      </p>
      <div
        role="radiogroup"
        aria-labelledby="oa-first-setup-h"
        className="grid gap-1.5"
      >
        {opts.map((o) => (
          <label
            key={o.id}
            className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 has-[:checked]:border-[var(--oa-accent)]"
          >
            <input
              type="radio"
              name="first-setup"
              className="mt-1"
              checked={pick === o.id}
              onChange={() => setPick(o.id)}
            />
            <span className="grid">
              <b className="text-[length:var(--oa-text-sm)] font-semibold">
                {o.label}
              </b>
              <span className="text-[length:var(--oa-text-xs)] text-muted-foreground">
                {o.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p
          role="alert"
          className="mt-2 mb-0 text-[length:var(--oa-text-sm)] text-destructive"
        >
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void markAsked().finally(() => setBusy(false));
          }}
        >
          {FIRST_ASK.skip}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void submitPick()}>
          {FIRST_ASK.next}
        </Button>
      </div>
    </section>
  );
}
