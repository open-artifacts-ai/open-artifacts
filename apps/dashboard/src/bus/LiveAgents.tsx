// #1293 placeholder: the data layer as plain lists. Design's layout replaces it.
import type { BusAddress, BusAgent } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import {
  useBusAgents,
  useSetShareNotices,
  useShareNotices,
} from "../api/queries";
import { LabelledCheckbox } from "../layout/LabelledCheckbox";
import { useDocumentTitle } from "../layout/useDocumentTitle";

const key = (a: BusAddress) => `${a.namespace}\n${a.name}`;

/** The addresses to pick from: every running agent's, once each, in list order. */
export const addressesOf = (agents: BusAgent[]): BusAddress[] => {
  const seen = new Set<string>();
  const out: BusAddress[] = [];
  for (const a of agents) {
    const ad = { namespace: a.namespace, name: a.name };
    if (seen.has(key(ad))) continue;
    seen.add(key(ad));
    out.push(ad);
  }
  return out;
};

/** `picks` with `a` on or off (by address), never repeated. */
export const togglePick = (
  picks: BusAddress[],
  a: BusAddress,
  on: boolean,
): BusAddress[] => {
  const rest = picks.filter((p) => key(p) !== key(a));
  return on ? [...rest, a] : rest;
};

export function LiveAgents() {
  useDocumentTitle("Agents");
  const agents = useBusAgents();
  return (
    <section>
      <h1>Agents</h1>
      {agents.isPending ? (
        <p>Loading…</p>
      ) : agents.isError ? (
        <p>
          Couldn't load your agents.{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void agents.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : (
        <>
          {!agents.data.live && <p>Couldn't reach your bus just now.</p>}
          {agents.data.agents.length === 0 ? (
            <p>No agents running</p>
          ) : (
            <ul aria-label="Live agents">
              {agents.data.agents.map((a) => (
                <li key={a.id}>
                  {a.name} · {a.namespace} · {a.machineLabel} ·{" "}
                  {a.state === "live" ? "Live" : "Queued"}
                </li>
              ))}
            </ul>
          )}
          <ShareNotices running={addressesOf(agents.data.agents)} />
        </>
      )}
    </section>
  );
}

function ShareNotices({ running }: { running: BusAddress[] }) {
  const q = useShareNotices();
  const set = useSetShareNotices();
  if (q.isPending) return <p>Loading…</p>;
  if (q.isError) return <p>Couldn't load share notices.</p>;
  const picks = q.data.agents;
  const picked = new Set(picks.map(key));
  const live = new Set(running.map(key));
  const gone = picks.filter((p) => !live.has(key(p)));
  return (
    <section aria-label="Share notices">
      <h2>Share notices</h2>
      <ul>
        {running.map((a, i) => (
          <li key={key(a)}>
            <LabelledCheckbox
              id={`share-notice-${i}`}
              label={`${a.name} · ${a.namespace}`}
              checked={picked.has(key(a))}
              disabled={set.isPending}
              onCheckedChange={(on) => set.mutate(togglePick(picks, a, on))}
            />
          </li>
        ))}
        {gone.map((a) => (
          <li key={key(a)}>
            {a.name} · {a.namespace} · not running{" "}
            <Button
              variant="outline"
              size="sm"
              aria-label={`Remove ${a.name} · ${a.namespace}`}
              disabled={set.isPending}
              onClick={() => set.mutate(togglePick(picks, a, false))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {gone.length > 0 && (
        <p>Notes to agents that aren't running are dropped.</p>
      )}
    </section>
  );
}
