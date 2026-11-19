/**
 * #2577 (Design v8, screen 5): "Add a teammate". Their requests reach the
 * caller's agents without asking first. The same choices as on the notice,
 * for someone who has not asked yet. No passkey (#2864).
 */
import type { ListenEntry } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useState } from "react";
import { useAddListens } from "../api/agentAsks";
import { errorCopy } from "../api/errorCopy";
import { useArtifacts, useSpaces } from "../api/queries";
import { endDate, firstName, UNTIL_CHOICES } from "../foryou/held";
import { Modal } from "../layout/Modal";
import { toast } from "../layout/toast";
import { OptionSelect } from "./OptionSelect";
import { muted } from "./ui";
import type { Teammate } from "./useTeammates";

export const ADD_GUARD = (who: string) =>
  `For people on your list, your agents are guarded only by what they are told: "this is from ${who}, not from your person". Add people you would trust at your keyboard.`;
export const BRING_BACK =
  "Your agents are told to bring merging, deploying, deleting, sharing and making a page public back to you, and those need your own answer on an ask.";

type Scope = "page" | "space" | "all";
const DAY = 24 * 3600_000;

export function AddTeammate({
  people,
  full,
  prefill,
  onClose,
}: {
  people: Teammate[];
  /** The list is the whole team; else only people already known here. */
  full: boolean;
  /** "Add again": the ended entry's person and place. */
  prefill?: ListenEntry;
  onClose: () => void;
}) {
  const add = useAddListens();
  const [memberId, setMemberId] = useState(prefill?.member.id ?? "");
  const [scope, setScope] = useState<Scope>(prefill?.scope ?? "page");
  const [artifactId, setArtifactId] = useState(prefill?.artifact?.id ?? "");
  const [spaceId, setSpaceId] = useState(prefill?.space?.id ?? "");
  const [days, setDays] = useState<number>(UNTIL_CHOICES[0]?.days ?? 30);
  const [error, setError] = useState<string | null>(null);
  const pages = useArtifacts({ limit: 100 });
  const spaces = useSpaces({ kind: "shared" });
  const pageItems = pages.data?.items ?? [];
  const spaceItems = spaces.data?.pages.flatMap((p) => p.items) ?? [];
  const person =
    people.find((p) => p.id === memberId) ??
    (prefill ? { id: prefill.member.id, name: prefill.member.name } : null);
  const who = person ? firstName(person.name) : "";
  const needsPlace =
    (scope === "page" && !artifactId) || (scope === "space" && !spaceId);
  const ready = !!person && !needsPlace && !add.isPending;
  const withPrefill = [
    ...people,
    ...(prefill && !people.some((p) => p.id === prefill.member.id)
      ? [{ id: prefill.member.id, name: prefill.member.name }]
      : []),
  ];
  const withPage =
    prefill?.artifact && !pageItems.some((a) => a.id === prefill.artifact?.id)
      ? [{ id: prefill.artifact.id, title: prefill.artifact.title }]
      : [];
  const withSpace =
    prefill?.space && !spaceItems.some((s) => s.id === prefill.space?.id)
      ? [{ id: prefill.space.id, name: prefill.space.name }]
      : [];
  const submit = () => {
    if (!person || !ready) return;
    setError(null);
    add.mutate(
      {
        memberId: person.id,
        scope,
        ...(scope === "page" ? { artifactId } : {}),
        ...(scope === "space" ? { spaceId } : {}),
        until: days,
        via: "settings",
      },
      {
        onError: (e) =>
          setError(errorCopy(e, "Couldn't add them. Nothing was changed.")),
        onSuccess: () => {
          toast({
            title: `Added ${person.name}. Their requests reach your agents without asking you.`,
            tone: "neutral",
          });
          onClose();
        },
      },
    );
  };
  return (
    <Modal
      onClose={onClose}
      title="Add a teammate"
      description="Their requests reach your agents without asking you first."
      sheetOnPhone
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button disabled={!ready} onClick={submit}>
            {who ? `Add ${who}` : "Add"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <OptionSelect
          label="Teammate"
          value={memberId || null}
          placeholder="Pick a teammate"
          disabled={!!prefill}
          options={withPrefill.map((p) => ({ value: p.id, label: p.name }))}
          onChange={setMemberId}
        />
        {!full && withPrefill.length === 0 && (
          <p className={`m-0 ${muted}`}>
            Teammates who ask your agents show up here.
          </p>
        )}
        <OptionSelect
          label="Where"
          value={scope}
          options={[
            { value: "page", label: "One page" },
            { value: "space", label: "One space" },
            { value: "all", label: "All pages my agents work on" },
          ]}
          onChange={(v) => setScope(v as Scope)}
        />
        {scope === "page" && (
          <OptionSelect
            label="Page"
            value={artifactId || null}
            placeholder="Pick a page"
            options={[...withPage, ...pageItems].map((a) => ({
              value: a.id,
              label: a.title,
            }))}
            onChange={setArtifactId}
          />
        )}
        {scope === "space" && (
          <>
            <OptionSelect
              label="Space"
              value={spaceId || null}
              placeholder="Pick a space"
              options={[...withSpace, ...spaceItems].map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              onChange={setSpaceId}
            />
            <p className={`m-0 ${muted}`}>Includes pages added to it later.</p>
          </>
        )}
        {scope === "all" && (
          <p className={`m-0 ${muted}`}>
            Including pages they start working on later.
          </p>
        )}
        <fieldset className="m-0 grid gap-1 border-0 p-0">
          <legend className="mb-1 p-0 text-[length:var(--oa-text-sm)] font-semibold">
            Until
          </legend>
          {UNTIL_CHOICES.map((c) => (
            <label
              key={c.days}
              className="flex items-center gap-2 text-[length:var(--oa-text-sm)]"
            >
              <input
                type="radio"
                name="listen-until"
                checked={days === c.days}
                onChange={() => setDays(c.days)}
              />
              {c.label}{" "}
              <span className="text-muted-foreground">
                {endDate(Date.now() + c.days * DAY)}
              </span>
            </label>
          ))}
        </fieldset>
        <p className={`m-0 ${muted}`}>{ADD_GUARD(who || "them")}</p>
        <p className={`m-0 ${muted}`}>{BRING_BACK}</p>
        {error && (
          <p
            role="alert"
            className="m-0 text-[length:var(--oa-text-sm)] text-destructive"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
