import { type Settings, SettingsSchema } from "@oa/shared";
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  Input,
  Label,
  ToggleGroup,
  ToggleGroupItem,
} from "@oa/ui/shadcn";
import { useState } from "react";
import { useSettings, useUpdateSettings } from "../api/queries";
import { useMe } from "../auth/useMe";
import { Notice } from "../layout/Notice";
import { instanceUpdate } from "../layout/update";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { CARD, errorText, INSET, muted, STACK } from "./ui";
import { VersionCard } from "./VersionCard";

const VISIBILITY = [
  { value: "private", label: "Private" },
  { value: "team", label: "Team" },
] as const;
const NAME_MAX = 80;
const HELP = {
  private: "Only the creator and the people they share with.",
  team: "Everyone on this instance can find and open it.",
};

export function Instance() {
  useDocumentTitle("Instance");
  const state = useMe();
  const latest = instanceUpdate(state.status === "authed" ? state.me : null);
  return (
    <div className={STACK}>
      {latest && <VersionCard update={latest} />}
      <InstanceSettings />
    </div>
  );
}

function InstanceSettings() {
  const settings = useSettings();
  const update = useUpdateSettings();
  // Only edited fields live here; everything else reads through from the server.
  const [draft, setDraft] = useState<Partial<Settings>>({});
  // Local, not `saving`: it must lock the form in the same render as the click.
  const [saving, setSaving] = useState(false);
  if (settings.isError && !settings.data)
    return (
      <Notice
        tone="danger"
        title="Couldn't load instance settings"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void settings.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  if (!settings.data) return <p aria-busy="true">Loading…</p>;
  const server = settings.data;
  const name = draft.name ?? server.name;
  const visibility = draft.defaultVisibility ?? server.defaultVisibility;
  const patch: Partial<Settings> = {};
  const trimmed = name.trim();
  const nameOk = trimmed.length >= 1 && trimmed.length <= NAME_MAX;
  if (draft.name !== undefined && trimmed !== server.name) patch.name = trimmed;
  if (
    draft.defaultVisibility !== undefined &&
    draft.defaultVisibility !== server.defaultVisibility
  )
    patch.defaultVisibility = draft.defaultVisibility;
  const dirty = Object.keys(patch).length > 0;
  const valid = nameOk && SettingsSchema.partial().safeParse(patch).success;
  const save = () => {
    setSaving(true);
    // Success or failure, drop the draft: the refetch shows the truth (a rollback on error).
    update.mutate(patch, {
      onSettled: () => {
        setSaving(false);
        setDraft({});
      },
    });
  };
  return (
    <Card className={CARD}>
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && valid) save();
        }}
      >
        <CardContent className={`grid min-w-0 ${INSET}`}>
          {settings.isError && (
            <div className="pb-[var(--oa-space-3)]">
              <Notice tone="warning" title="Couldn't refresh settings.">
                Showing the last loaded values. Your edits are kept.
              </Notice>
            </div>
          )}
          <div className={FIELD}>
            <div className={HINT}>
              <Label htmlFor="oa-inst-name" className={LABEL}>
                Instance name
              </Label>
              <p className={muted}>
                Shown in the sidebar, page titles, and on the sign-in page.
              </p>
            </div>
            <div className="grid min-w-0 gap-[var(--oa-space-1)]">
              <Input
                id="oa-inst-name"
                value={name}
                maxLength={NAME_MAX}
                disabled={saving}
                aria-describedby={nameOk ? undefined : "oa-inst-name-err"}
                placeholder="e.g. Northwind Eng"
                aria-invalid={!nameOk || undefined}
                className="h-[30px] text-[length:var(--oa-text-sm)]"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              {!nameOk && (
                <p className={errorText} id="oa-inst-name-err" role="alert">
                  Name must be 1 to {NAME_MAX} characters.
                </p>
              )}
            </div>
          </div>
          <div className={FIELD}>
            <div className={HINT}>
              <span id="oa-inst-vis" className={LABEL}>
                Default visibility
              </span>
              <p className={muted}>
                For new artifacts from agents and uploads. Public is always
                chosen per artifact.
              </p>
            </div>
            <div className="grid min-w-0 justify-items-start gap-[var(--oa-space-1)]">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                aria-label="Default visibility"
                disabled={saving}
                value={visibility}
                // Single toggle groups can deselect; keep one chosen.
                onValueChange={(v) =>
                  v &&
                  setDraft({
                    ...draft,
                    defaultVisibility: v as Settings["defaultVisibility"],
                  })
                }
              >
                {VISIBILITY.map((o) => (
                  <ToggleGroupItem
                    key={o.value}
                    value={o.value}
                    className="h-[30px] px-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]"
                  >
                    {o.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className={muted}>{HELP[visibility]}</p>
            </div>
          </div>
        </CardContent>
        <CardFooter
          className={`justify-end gap-[var(--oa-space-2)] border-t ${INSET} [.border-t]:pt-[var(--oa-space-5)] max-[600px]:[.border-t]:pt-[var(--oa-space-4)]`}
        >
          <Button
            variant="ghost"
            type="button"
            size="sm"
            className="text-[length:var(--oa-text-sm)]"
            disabled={!Object.keys(draft).length || saving}
            onClick={() => setDraft({})}
          >
            Discard
          </Button>
          <Button
            type="submit"
            size="sm"
            className="text-[length:var(--oa-text-sm)]"
            disabled={!dirty || !valid || saving}
          >
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Label and hint beside the control; stacked at <= 600px. Rows are divided
    by a hairline and 16px above and below it. */
const FIELD =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-x-[var(--oa-space-6)] gap-y-[var(--oa-space-3)] border-0 border-b border-border py-[var(--oa-space-4)] first:pt-0 last:border-b-0 last:pb-0 max-[600px]:grid-cols-1";
const HINT = "grid gap-[2px]";
const LABEL = "text-[length:var(--oa-text-sm)] font-medium";
