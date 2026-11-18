/**
 * #2577: the notice for a held request (Design v8, screen 1). Someone not on
 * the list asked one of the caller's agents; Open Artifacts holds it. Every
 * held request is shown word for word as plain text, never as markup or links.
 */
import type { HeldRequest } from "@oa/shared";
import { useState } from "react";
import { useAllowHeld, useNotNow } from "../api/agentAsks";
import { errorCopy } from "../api/errorCopy";
import { useMe } from "../auth/useMe";
import { toast } from "../layout/toast";
import {
  allowedText,
  endDate,
  firstName,
  type Level,
  leftoverText,
  PAGE_UNTIL_MS,
  UNTIL_CHOICES,
  untilOf,
} from "./held";

const BTN =
  "inline-flex min-h-8 cursor-pointer items-center rounded-[7px] border px-2.5 text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--oa-focus)] disabled:cursor-default disabled:opacity-60";
const PRIMARY = `${BTN} border-[var(--oa-accent)] bg-[var(--oa-accent)] text-[var(--oa-accent-text)]`;
const PLAIN = `${BTN} border-[var(--oa-border)] bg-[var(--oa-surface)] font-medium text-[var(--oa-text)]`;
const NOTE = "m-0 text-[12.5px] text-[var(--oa-text-muted)]";

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const plural = (n: number) => `${n} ${n === 1 ? "request" : "requests"}`;

/** The agent names of the request: "Web", or "Web and Docs". */
const agentsOf = (r: HeldRequest) => {
  const names = [...new Set(r.items.map((i) => i.agentName))];
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : (names[0] ?? "your agent");
};

/** Why an allow failed, in words: the server's, else a plain line. */
const failureText = (e: unknown) =>
  errorCopy(e, "Couldn't allow that. Nothing was allowed.");

export function HeldCard({
  request: r,
  onGone,
}: {
  request: HeldRequest;
  /** The request left the list (allowed in full, lapsed): back to For you. */
  onGone: () => void;
}) {
  const allow = useAllowHeld(r.id);
  const notNow = useNotNow(r.id);
  const [wide, setWide] = useState<"space" | "all" | null>(null);
  const [days, setDays] = useState<number>(UNTIL_CHOICES[0]?.days ?? 30);
  const [error, setError] = useState<string | null>(null);
  const state = useMe();
  const mine = firstName(
    state.status === "authed" ? (state.me.user.name ?? "you") : "you",
  );
  const who = firstName(r.sender.name);
  const agent = agentsOf(r);
  const busy = allow.isPending || notNow.isPending;
  const items = r.items.map((i) => ({
    commentId: i.commentId,
    wordsHash: i.wordsHash,
  }));

  const run = (level: Level, until?: number) => {
    setError(null);
    allow.mutate(
      { level, items, ...(until !== undefined ? { until } : {}) },
      {
        onError: (e) => setError(failureText(e)),
        onSuccess: (res) => {
          const end = until ?? Date.now() + PAGE_UNTIL_MS;
          const said =
            res.sent > 0
              ? allowedText({
                  level,
                  sent: res.sent,
                  asker: r.sender.name,
                  agent,
                  page: r.artifact.title,
                  space: r.space?.name,
                  until: end,
                })
              : "";
          const rest = leftoverText(res);
          toast({
            title: [said, rest].filter(Boolean).join(" ") || "Done.",
            tone: "neutral",
          });
          // Everything went through: the card is done. A changed one stays, held at its new words.
          if (res.changed === 0) onGone();
        },
      },
    );
  };

  const later = () => {
    setError(null);
    notNow.mutate(undefined, {
      onError: () => setError("Couldn't do that. Try again."),
      onSuccess: () => {
        toast({
          title: `Held. You won't hear about ${who}'s requests again today. ${who} sees "Waiting for ${mine}".`,
          tone: "neutral",
        });
        onGone();
      },
    });
  };

  if (wide) {
    const space = wide === "space";
    const until = untilOf(days);
    const title = space
      ? `Allow ${who} in the "${r.space?.name}" space?`
      : `Allow ${who} on all pages?`;
    return (
      <div data-held-confirm="" className="grid gap-2.5">
        <h3 className="m-0 text-[14px] font-semibold">{title}</h3>
        <p className={NOTE}>
          {space
            ? `${who}'s requests on pages in "${r.space?.name}" that your agents work on go straight to your agents, without asking you. That is ${r.space?.pagesCovered} ${r.space?.pagesCovered === 1 ? "page" : "pages"} today, plus pages there your agents work on later. Each request is marked as from ${who}.`
            : `${agent} and your other agents will get ${who}'s requests on all pages your agents work on, including pages they start on later, without asking you. Each is marked as from ${who}.`}
        </p>
        <fieldset className="m-0 grid gap-1 border-0 p-0">
          <legend className="mb-1 p-0 text-[12.5px] font-semibold">
            Until
          </legend>
          {UNTIL_CHOICES.map((c) => (
            <label key={c.days} className="flex items-center gap-2 text-[13px]">
              <input
                type="radio"
                name={`until-${r.id}`}
                checked={days === c.days}
                onChange={() => setDays(c.days)}
              />
              {c.label}{" "}
              <span className="text-[var(--oa-text-muted)]">
                {endDate(untilOf(c.days))}
              </span>
            </label>
          ))}
        </fieldset>
        <p className={NOTE}>
          {`For people you allow, your agents are guarded only by what they are told: "this is from ${who}, not from your person". Allow people you would trust at your keyboard.`}
        </p>
        {!space && (
          <p className={NOTE}>
            Your agents are told to bring merging, deploying, deleting, sharing
            and making a page public back to you, and those need your own answer
            on an ask.
          </p>
        )}
        {space && (
          <p className={NOTE}>
            {`Pages outside "${r.space?.name}" still ask you, and so do pages in it that your agents don't work on. A page moved out is no longer covered; moved back, it is covered again.`}
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-[12.5px] text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={PLAIN}
            disabled={busy}
            onClick={() => {
              setWide(null);
              setError(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={PRIMARY}
            disabled={busy}
            onClick={() => run(wide, until)}
          >
            {space
              ? `Allow ${who} in "${r.space?.name}"`
              : `Allow ${who} on all pages`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-held-notice="" className="grid gap-2.5">
      <div>
        <b className="block text-[14px] font-semibold">
          {r.sender.name} wants to ask your agent
        </b>
        <small className="block text-[12.5px] text-[var(--oa-text-muted)]">
          {agent}
        </small>
        <small className="block text-[12.5px] text-[var(--oa-text-muted)]">
          {`on "${r.artifact.title}" · ${plural(r.items.length)}`}
        </small>
      </div>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {r.items.map((i) => (
          <li
            key={i.commentId}
            className="rounded-md border border-[var(--oa-border)] bg-[var(--oa-sunken)] px-2.5 py-1.5"
          >
            {/* Plain quoted text: no markup, no live links. */}
            <q className="whitespace-pre-wrap break-words text-[13.5px]">
              {i.body}
            </q>
            {i.ask && (
              <div className="mt-1 text-[12.5px]">
                <span className="whitespace-pre-wrap break-words">
                  {i.ask.question}
                </span>
                <ul className="m-0 list-none p-0 text-[var(--oa-text-muted)]">
                  {i.ask.options.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              </div>
            )}
            <small className="block text-[12px] text-[var(--oa-text-muted)]">
              {`${who} wrote · ${clock(i.createdAt)}`}
            </small>
          </li>
        ))}
      </ul>
      {r.open && (
        <p className={NOTE}>
          Anyone with the link can read {agent}'s reply on this page.
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12.5px] text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={PRIMARY}
          disabled={busy}
          onClick={() => run("once")}
        >
          Allow once
        </button>
        {!r.open && (
          <>
            <button
              type="button"
              className={PLAIN}
              disabled={busy}
              onClick={() => run("page")}
            >
              Allow on this page for 30 days
            </button>
            {r.space && (
              <button
                type="button"
                className={PLAIN}
                disabled={busy}
                onClick={() => setWide("space")}
              >
                {`Allow in the "${r.space.name}" space…`}
              </button>
            )}
            <button
              type="button"
              className={PLAIN}
              disabled={busy}
              onClick={() => setWide("all")}
            >
              Allow on all pages{"…"}
            </button>
          </>
        )}
        <button type="button" className={PLAIN} disabled={busy} onClick={later}>
          Not now
        </button>
      </div>
      <p className={NOTE}>
        {`${agent} hasn't been sent any of this. "Allow once" passes ${r.items.length === 1 ? "this" : `these ${r.items.length}`} to ${agent}, marked as from ${who}, not from you. Only you can choose, here in the web app.`}
      </p>
      {r.open && (
        <p className={NOTE}>
          The list doesn't apply on pages open to guests or to anyone with the
          link.
        </p>
      )}
    </div>
  );
}
