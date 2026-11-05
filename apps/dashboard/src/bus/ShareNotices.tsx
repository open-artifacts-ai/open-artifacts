// #1293: Agents › Share notices (#1292): which agent addresses get a note
// when someone shares an artifact with the member.
import { type BusAddress, type BusAgent, SHARE_NOTICE_MAX } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useState } from "react";
import {
  useBusAgents,
  useSetShareNotices,
  useShareNotices,
} from "../api/queries";
import { LabelledCheckbox } from "../layout/LabelledCheckbox";
import { LoadError } from "../layout/LoadError";
import { toast } from "../layout/toast";
import { muted, SettingsCard } from "../settings/ui";
import { listOf, shortName } from "./namespaces";

const key = (a: BusAddress) => `${a.namespace}\n${a.name}`;

/** A running address and the machines its agents are on. */
export type Running = BusAddress & { machines: string[] };

/** The addresses to pick from: every running agent's, once each, in list order. */
export const addressesOf = (agents: BusAgent[]): Running[] => {
  const out = new Map<string, Running>();
  for (const a of agents) {
    const k = key(a);
    const was = out.get(k);
    if (was) {
      if (!was.machines.includes(a.machineLabel))
        was.machines.push(a.machineLabel);
    } else
      out.set(k, {
        namespace: a.namespace,
        name: a.name,
        machines: [a.machineLabel],
      });
  }
  return [...out.values()];
};

/** `picks` with `a` on or off (by address), never repeated. */
export const togglePick = (
  picks: BusAddress[],
  a: BusAddress,
  on: boolean,
): BusAddress[] => {
  const rest = picks.filter((p) => key(p) !== key(a));
  return on ? [...rest, { namespace: a.namespace, name: a.name }] : rest;
};

const same = (a: BusAddress[], b: BusAddress[]) =>
  a.length === b.length && a.every((x) => b.some((y) => key(x) === key(y)));

export function ShareNoticesTab() {
  const agents = useBusAgents();
  const q = useShareNotices();
  if (q.isPending || agents.isPending)
    return <p className={`m-0 ${muted}`}>Loading…</p>;
  if (q.isError)
    return (
      <LoadError
        title="Couldn't load share notices."
        error={q.error}
        busy={q.isFetching}
        onRetry={() => void q.refetch()}
      />
    );
  // The key resets the draft when the saved list changes under it.
  return (
    <Picker
      key={q.data.agents.map(key).join("\t")}
      saved={q.data.agents}
      running={agents.data?.live ? addressesOf(agents.data.agents) : null}
    />
  );
}

function Picker({
  saved,
  running,
}: {
  saved: BusAddress[];
  /** null: running agents can't be listed right now (remove-only). */
  running: Running[] | null;
}) {
  const set = useSetShareNotices();
  const [draft, setDraft] = useState(saved);
  const live = new Set((running ?? []).map(key));
  const picked = new Set(draft.map(key));
  const gone = draft.filter((p) => !live.has(key(p)));
  const full = draft.length >= SHARE_NOTICE_MAX;
  const all = [
    ...new Set([
      ...(running ?? []).map((a) => a.namespace),
      ...draft.map((a) => a.namespace),
    ]),
  ];
  const label = (a: BusAddress) => `${a.name} · ${shortName(a.namespace, all)}`;
  const save = () =>
    set.mutate(draft, {
      onSuccess: () =>
        toast({ title: "Share notices saved.", tone: "success" }),
    });
  return (
    <SettingsCard
      id="oa-share-h"
      title="Share notices"
      subtitle={
        full
          ? `${SHARE_NOTICE_MAX} of ${SHARE_NOTICE_MAX} picked. Remove one to pick another.`
          : `${draft.length} of ${SHARE_NOTICE_MAX} picked`
      }
    >
      <p className="m-0 text-[length:var(--oa-text-sm)]">
        When someone shares an artifact with you, the agents you pick get a
        short note with a link to it. The note has the link and who shared it,
        never the artifact itself. With none picked, no agent is told; you still
        get the email, and it shows in Shared with me.
      </p>
      {running === null ? (
        <p className={`m-0 ${muted}`}>
          Running agents can't be listed right now.
        </p>
      ) : running.length === 0 ? (
        <p className={`m-0 ${muted}`}>
          Agents show up here while a session is running on one of your
          machines.
        </p>
      ) : (
        <ul
          aria-label="Running agents"
          className="m-0 grid list-none gap-[var(--oa-space-2)] p-0"
        >
          {running.map((a, i) => (
            <li key={key(a)} className="grid gap-[2px]">
              <LabelledCheckbox
                id={`share-notice-${i}`}
                label={label(a)}
                checked={picked.has(key(a))}
                disabled={set.isPending || (full && !picked.has(key(a)))}
                onCheckedChange={(on) => setDraft(togglePick(draft, a, on))}
              />
              <span className={`ps-[24px] ${muted}`}>
                on {listOf(a.machines)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {gone.length > 0 && (
        <>
          <ul
            aria-label="Picked, not running"
            className="m-0 grid list-none gap-[var(--oa-space-1)] p-0"
          >
            {gone.map((a) => (
              <li
                key={key(a)}
                className="flex min-w-0 items-center justify-between gap-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]"
              >
                <span className="min-w-0 truncate">
                  {label(a)}{" "}
                  <span className="text-muted-foreground">· not running</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${label(a)}`}
                  disabled={set.isPending}
                  onClick={() => setDraft(togglePick(draft, a, false))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <p className={`m-0 ${muted}`}>
            Notes to agents that aren't running are dropped.
          </p>
        </>
      )}
      <div>
        <Button
          size="sm"
          disabled={set.isPending || same(draft, saved)}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </SettingsCard>
  );
}
