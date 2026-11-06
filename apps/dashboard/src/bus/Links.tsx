// #1567: Agents › Namespaces › Links. The member links two namespaces so
// their agents see and message each other. Two-way, direct only (never
// chained), and only the member writes one: no agent can, over the bus or MCP.
import {
  BUS_LINK_MAX,
  BUS_LINKS_PER_NAMESPACE,
  type BusLink,
} from "@oa/shared";
import { Button, useIsMobile } from "@oa/ui/shadcn";
import { useState } from "react";
import { ApiClientError } from "../api/client";
import { useBusLinks, useDeleteBusLink, usePutBusLink } from "../api/queries";
import { LoadError } from "../layout/LoadError";
import { Modal } from "../layout/Modal";
import { Notice } from "../layout/Notice";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { OptionSelect } from "../settings/OptionSelect";
import { errorText, muted, SettingsCard } from "../settings/ui";
import { shortName } from "./namespaces";
import { LIVE_DOWN } from "./ui";

/** PUT R.busLinks refusals (409 details.reason) as plain lines. */
export const LINK_REFUSALS: Record<string, string> = {
  link_limit: `You've reached the most links allowed: ${BUS_LINK_MAX} in all, ${BUS_LINKS_PER_NAMESPACE} for one namespace. Remove one first.`,
  no_bus: "Connect a machine first.",
};

export function linkError(e: unknown): string {
  if (e instanceof ApiClientError) {
    const reason = (e.details as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === "string" && LINK_REFUSALS[reason])
      return LINK_REFUSALS[reason];
    if (e.code === "bad_request") {
      const field = (e.details as { field?: unknown } | undefined)?.field;
      if (field === "a") return "The first namespace isn't valid.";
      if (field === "b") return "The second namespace isn't valid.";
      return "Pick two different namespaces.";
    }
  }
  return "That didn't save. Try again.";
}

/** The namespaces linked directly to `ns` (never through another), A to Z. */
export const linkedTo = (links: readonly BusLink[], ns: string): string[] =>
  links
    .filter((l) => l.a === ns || l.b === ns)
    .map((l) => (l.a === ns ? l.b : l.a))
    .sort();

const isLinked = (links: readonly BusLink[], x: string, y: string) =>
  links.some((l) => (l.a === x && l.b === y) || (l.a === y && l.b === x));

function LinkDialog({
  namespaces,
  links,
  onClose,
}: {
  namespaces: string[];
  links: BusLink[];
  onClose: () => void;
}) {
  const put = usePutBusLink();
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dupe = a !== null && b !== null && isLinked(links, a, b);
  const ok = a !== null && b !== null && !dupe;
  const options = (skip: string | null) =>
    namespaces
      .filter((n) => n !== skip)
      .map((n) => ({ value: n, label: shortName(n, namespaces) }));
  const save = async () => {
    if (a === null || b === null || dupe) return;
    setError(null);
    try {
      await put.mutateAsync({ a, b });
      onClose();
    } catch (e) {
      setError(linkError(e));
    }
  };
  return (
    <Modal
      onClose={onClose}
      title="Link two namespaces"
      description="Agents in both see each other and can message each other. It works both ways and covers every agent in each."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok || put.isPending} onClick={() => void save()}>
            Link
          </Button>
        </>
      }
    >
      <div className="grid gap-[var(--oa-space-3)]">
        <div className="grid gap-[4px]">
          <span className="text-[length:var(--oa-text-sm)] font-medium">
            First namespace
          </span>
          <OptionSelect
            label="First namespace"
            value={a}
            placeholder="Pick a namespace"
            options={options(b)}
            onChange={setA}
          />
        </div>
        <div className="grid gap-[4px]">
          <span className="text-[length:var(--oa-text-sm)] font-medium">
            Second namespace
          </span>
          <OptionSelect
            label="Second namespace"
            value={b}
            placeholder="Pick a namespace"
            options={options(a)}
            onChange={setB}
          />
        </div>
        {dupe && <p className={`m-0 ${muted}`}>They are already linked.</p>}
        <p className={`m-0 ${muted}`}>
          Links don't chain. Linking A to B and B to C doesn't let A reach C.
        </p>
        {error && (
          <p role="alert" className={`m-0 ${errorText}`}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** The Links card on Agents › Namespaces. `known` is every namespace in view. */
export function LinksCard({ known }: { known: string[] }) {
  const q = useBusLinks();
  const remove = useDeleteBusLink();
  const stacked = useIsMobile();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<BusLink | null>(null);
  const links = q.data?.live ? q.data.links : [];
  const all = [
    ...new Set([...known, ...links.flatMap((l) => [l.a, l.b])]),
  ].sort();
  const name = (ns: string) => shortName(ns, all);
  const body = () => {
    if (q.isPending) return <p className={`m-0 ${muted}`}>Loading…</p>;
    if (q.isError)
      return (
        <LoadError
          title="Couldn't load your links."
          error={q.error}
          busy={q.isFetching}
          onRetry={() => void q.refetch()}
        />
      );
    if (!q.data.live) return <Notice tone="warning">{LIVE_DOWN}</Notice>;
    if (links.length === 0)
      return (
        <p className={`m-0 ${muted}`}>
          No links yet. Each namespace sees only its own agents.
        </p>
      );
    return (
      <ul aria-label="Links" className="m-0 list-none p-0">
        {links.map((l) => (
          <li
            key={l.id}
            className={`flex items-center justify-between gap-[var(--oa-space-3)] border-b py-[var(--oa-space-2)] text-[length:var(--oa-text-sm)] last:border-b-0 ${stacked ? "flex-wrap" : ""}`}
          >
            <span className="min-w-0 break-words">
              <b title={l.a}>{name(l.a)}</b>
              <span role="img" aria-label="linked with">
                {" ↔ "}
              </span>
              <b title={l.b}>{name(l.b)}</b>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              aria-label={`Remove the link between ${name(l.a)} and ${name(l.b)}`}
              onClick={() => setRemoving(l)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    );
  };
  return (
    <>
      <SettingsCard
        id="oa-links-h"
        title="Links"
        subtitle="Linked namespaces see each other's agents and can message each other, on every machine. Links don't chain."
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={!q.data?.live || all.length < 2}
            onClick={() => setAdding(true)}
          >
            Link namespaces
          </Button>
        }
      >
        {body()}
        {q.data?.live && all.length < 2 && (
          <p className={`m-0 ${muted}`}>
            Linking needs two namespaces with agents seen here. Or run{" "}
            <code>oa-bus link</code> from the two folders.
          </p>
        )}
      </SettingsCard>
      {adding && (
        <LinkDialog
          namespaces={all}
          links={links}
          onClose={() => setAdding(false)}
        />
      )}
      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          title="Remove this link?"
          body={
            <p>
              Agents in {name(removing.a)} and {name(removing.b)} stop seeing
              each other and can't message each other.
            </p>
          }
          confirm="Remove"
          danger
          onConfirm={() => {
            remove.mutate(removing.id);
            setRemoving(null);
          }}
        />
      )}
    </>
  );
}
