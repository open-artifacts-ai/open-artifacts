/**
 * #2577: "Who can ask my agents" (Design v8, screen 5). The switch for
 * teammates asking the caller's agents, and "My agents listen to": the people
 * whose requests go straight to those agents. Adding someone and the other
 * screens come in a later slice.
 */
import type { ListenEntry } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useState } from "react";
import {
  useAgentRequests,
  useListens,
  useRemoveListen,
  useSetAgentRequests,
} from "../api/agentAsks";
import { errorCopy } from "../api/errorCopy";
import { toast } from "../layout/toast";
import { initials } from "../viewer/comments/AuthorFace";
import { AddTeammate } from "./AddTeammate";
import { AskHistory } from "./AskHistory";
import { Switch } from "./spaces/Switch";
import { errorText, muted, SettingsCard, WriteLock } from "./ui";
import { useTeammates } from "./useTeammates";

export const REQUESTS_OFF =
  "Off: your agents only answer you, and teammates are told so.";
export const REQUESTS_ON =
  "On: anyone not on your list waits until you allow them.";
export const LISTENS_FINE_PRINT =
  "Your agents are told to bring merging, deploying, deleting, sharing and making a page public back to you, and those need your own answer on an ask. The list doesn't apply on pages open to guests or to anyone with the link.";
export const LISTENS_EMPTY =
  "Nobody yet. When a teammate asks one of your agents, you choose how much to allow, and they show up here.";

const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** "All pages my agents work on", `"Launch status" only`, `Pages in the "Launch" space`. */
export const scopeLine = (e: ListenEntry) =>
  e.scope === "all"
    ? "All pages my agents work on"
    : e.scope === "page"
      ? `"${e.artifact?.title ?? "A page"}" only`
      : `Pages in the "${e.space?.name ?? "a"}" space`;

/** "until 15 Feb", or "ended 2 Nov" once it has passed. */
export const endLine = (e: ListenEntry, now = Date.now()) =>
  e.until > now ? `until ${shortDate(e.until)}` : `ended ${shortDate(e.until)}`;

export function AgentRequests() {
  const sw = useAgentRequests();
  const save = useSetAgentRequests();
  const listens = useListens();
  const remove = useRemoveListen();
  const team = useTeammates();
  // "Add a teammate", or "Add again" on an ended entry (prefilled).
  const [adding, setAdding] = useState<{ prefill?: ListenEntry } | null>(null);
  const on = save.isPending ? save.variables : (sw.data?.on ?? true);
  return (
    <>
      <SettingsCard
        id="oa-ask-h"
        title="Who can ask my agents"
        subtitle="Teammates can ask your agents about pages those agents work on. You choose who gets through without asking you."
      >
        <div className="flex items-center justify-between gap-3">
          <span id="oa-ask-sw" className="text-[length:var(--oa-text-sm)]">
            Teammates can ask my agents
          </span>
          <WriteLock>
            <Switch
              label="Teammates can ask my agents"
              describedBy="oa-ask-off"
              checked={on}
              disabled={sw.isPending || sw.isError}
              onChange={(next) =>
                save.mutate(next, {
                  onError: (e) =>
                    toast({
                      title: errorCopy(e, "Couldn't save that. Try again."),
                      tone: "danger",
                    }),
                })
              }
            />
          </WriteLock>
        </div>
        <p id="oa-ask-off" className={`m-0 ${muted}`}>
          {on ? REQUESTS_ON : `${REQUESTS_OFF} Your list is kept but not used.`}
        </p>
        {sw.isError && (
          <p role="alert" className={errorText}>
            Couldn't load this setting.
          </p>
        )}
      </SettingsCard>
      <SettingsCard
        id="oa-listens-h"
        title="My agents listen to"
        subtitle="Requests from these people go straight to your agents, marked with who asked. Everyone else's are held until you allow them."
      >
        {listens.isError ? (
          <p role="alert" className={errorText}>
            Couldn't load this list.
          </p>
        ) : listens.data?.entries.length === 0 ? (
          <p className={`m-0 ${muted}`}>{LISTENS_EMPTY}</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {listens.data?.entries.map((e) => (
              <li
                key={e.id}
                data-listen={e.id}
                className="flex items-center gap-3"
              >
                <span
                  aria-hidden="true"
                  className="grid size-[26px] flex-none place-items-center rounded-full border border-border bg-muted text-[10px] font-semibold"
                >
                  {initials(e.member.name)}
                </span>
                <span className="grid min-w-0 flex-1">
                  <b className="truncate text-[length:var(--oa-text-sm)] font-semibold">
                    {e.member.name}
                  </b>
                  <span className={muted}>
                    {scopeLine(e)} {"·"} {endLine(e)}
                  </span>
                </span>
                <WriteLock>
                  {e.until <= Date.now() ? (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-[length:var(--oa-text-xs)] underline"
                      aria-label={`Add ${e.member.name} again`}
                      onClick={() => setAdding({ prefill: e })}
                    >
                      Add again
                    </Button>
                  ) : (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-[length:var(--oa-text-xs)] underline"
                      aria-label={`Remove ${e.member.name}`}
                      disabled={remove.isPending && remove.variables === e.id}
                      onClick={() =>
                        remove.mutate(e.id, {
                          onError: (x) =>
                            toast({
                              title: errorCopy(x, "Couldn't remove that."),
                              tone: "danger",
                            }),
                          onSuccess: () =>
                            toast({
                              title: `Removed ${e.member.name}. Their requests ask you again.`,
                              tone: "neutral",
                            }),
                        })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </WriteLock>
              </li>
            ))}
          </ul>
        )}
        <WriteLock>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => setAdding({})}
          >
            Add a teammate
          </Button>
        </WriteLock>
        <p className={`m-0 ${muted}`}>{LISTENS_FINE_PRINT}</p>
      </SettingsCard>
      <AskHistory />
      {adding && (
        <AddTeammate
          people={team.people}
          full={team.full}
          prefill={adding.prefill}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}
