/** #2577 (Design v8, screen 5): "Who asked what", the last 30 days. Names, pages and times only, never the words. */
import type { AskHistoryRow } from "@oa/shared";
import { useAskHistory } from "../api/agentAsks";
import { AuthorFace } from "../viewer/comments/AuthorFace";
import { errorText, muted, SettingsCard } from "./ui";

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "today", "yesterday", then "2 Nov". */
export function whenText(at: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (at >= today) return "today";
  if (at >= today - 24 * 3600_000) return "yesterday";
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export const OUTCOME_TEXT: Record<AskHistoryRow["outcome"], string> = {
  on_list: "on your list",
  allowed_once: "you allowed once",
  lapsed: "lapsed",
  not_now: "you said not now",
  held: "waiting for you",
};

export const HISTORY_EMPTY = "No requests to your agents in the last 30 days.";

export function AskHistory() {
  const q = useAskHistory();
  const rows = q.data?.rows ?? [];
  return (
    <SettingsCard
      id="oa-history-h"
      title="Who asked what"
      subtitle="The last 30 days."
    >
      {q.isError ? (
        <p role="alert" className={errorText}>
          Couldn't load this list.
        </p>
      ) : q.data && rows.length === 0 ? (
        <p className={`m-0 ${muted}`}>{HISTORY_EMPTY}</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {rows.map((r, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id
              key={`${r.at}-${r.asker.id}-${i}`}
              data-history-row=""
              className="flex items-start gap-3"
            >
              <AuthorFace
                a={{
                  kind: "agent",
                  name: r.agent.name,
                  linked: false,
                  me: false,
                }}
              />
              <span className="grid min-w-0">
                <b className="text-[length:var(--oa-text-sm)] font-semibold">
                  {r.agent.name}, asked by {r.asker.name}
                </b>
                <span className={muted}>
                  {[
                    r.artifact ? `on "${r.artifact.title}"` : null,
                    whenText(r.at),
                    OUTCOME_TEXT[r.outcome],
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
