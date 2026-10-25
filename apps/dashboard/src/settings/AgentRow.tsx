// A connected agent (Design ecAopo8RUyk2Xomu, contract #559): rows like
// Members. The name and version are the agent's own claims (tagged), where it
// runs and where it was approved are ours; nothing says "verified".
import type { OAuthClient } from "@oa/shared";
import { avatarHue } from "@oa/ui";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@oa/ui/shadcn";
import { useState } from "react";
import { useLabelOAuthClient } from "../api/queries";
import { initials } from "../layout/UserAvatar";
import { AppLink } from "../library/AppLink";
import { relativeTime } from "../library/time";
import { errorText, muted } from "./ui";

export const LABEL_MAX = 60;

const BROWSER: Record<string, string> = {
  chrome: "Chrome",
  safari: "Safari",
  firefox: "Firefox",
  edge: "Edge",
  other: "another browser",
};
const OS: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  chromeos: "ChromeOS",
  other: "another system",
};
const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

/**
 * Rounded-square initials of the agent's name (never the label) on the
 * connection's own hue: installs of one agent differ by colour.
 */
function Face({ c }: { c: OAuthClient }) {
  return (
    <span
      aria-hidden="true"
      data-face
      className="grid size-8 flex-none place-items-center rounded-md text-[12px] font-semibold text-white"
      style={{ backgroundColor: `hsl(${avatarHue(c.grantId)} 45% 30%)` }}
    >
      {initials(c.clientName, "")}
    </span>
  );
}

/** Design's T2 tag: only the self-reported name and version carry it. */
const Reported = () => (
  <span className="rounded-sm bg-[var(--oa-warning-soft)] px-[5px] font-mono text-[10.5px] whitespace-nowrap text-[var(--oa-warning)]">
    reported by the agent
  </span>
);

export function AgentRow({
  c,
  canLabel,
  onRevoke,
}: {
  c: OAuthClient;
  /** Capped viewers can't rename (the server answers 404). */
  canLabel: boolean;
  onRevoke: () => void;
}) {
  const label = useLabelOAuthClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reported = [c.clientName, c.clientVersion].filter(Boolean).join(" ");
  const versions = c.versionsPublished ?? 0;
  const old = !c.approvedFrom && !c.redirectKind;
  const edit = () => {
    setDraft(c.label ?? "");
    setError(null);
    setEditing(true);
  };
  const save = () => {
    const v = draft.trim();
    if ([...v].length > LABEL_MAX)
      return setError("Use 60 characters or fewer.");
    label.mutate(
      { grantId: c.grantId, label: v || null },
      {
        onSuccess: () => setEditing(false),
        onError: () => setError("Couldn't save the label. Try again."),
      },
    );
  };

  return (
    <li className="flex min-w-0 items-start gap-[var(--oa-space-3)] border-0 border-t border-border py-[var(--oa-space-3)] first:border-t-0">
      <Face c={c} />
      <div className="grid min-w-0 flex-1 gap-[2px] text-[length:var(--oa-text-sm)]">
        {editing ? (
          <div className="grid gap-[var(--oa-space-1)]">
            <label
              htmlFor={`${c.grantId}-label`}
              className="text-[length:var(--oa-text-sm)] font-medium"
            >
              Your label
            </label>
            <Input
              id={`${c.grantId}-label`}
              autoFocus
              value={draft}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${c.grantId}-label-help`}
              onChange={(e) => {
                setError(null);
                setDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              className="h-8 text-[length:var(--oa-text-sm)]"
            />
            <small id={`${c.grantId}-label-help`} className={muted}>
              Only you see it. Up to 60 characters.
            </small>
            {error && (
              <p role="alert" className={`m-0 ${errorText}`}>
                {error}
              </p>
            )}
            {/* Enter and Esc stay as shortcuts. */}
            <div className="flex gap-[var(--oa-space-2)]">
              <Button
                size="sm"
                disabled={label.isPending}
                aria-busy={label.isPending || undefined}
                onClick={save}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={label.isPending}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
            {/* What the label is for stays in view while you type. */}
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--oa-space-2)] gap-y-[2px]">
              <span className={`min-w-0 truncate ${muted}`} title={reported}>
                {reported}
              </span>
              <Reported />
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--oa-space-2)] gap-y-[2px]">
            {c.label ? (
              <>
                <b
                  className="min-w-0 truncate font-semibold max-[600px]:line-clamp-2 max-[600px]:whitespace-normal"
                  title={c.label}
                >
                  {c.label}
                </b>
                <span className={`min-w-0 truncate ${muted}`} title={reported}>
                  {reported}
                </span>
              </>
            ) : (
              <b className="min-w-0 truncate font-semibold" title={reported}>
                {reported}
              </b>
            )}
            <Reported />
          </div>
        )}
        {old ? (
          <span className={`${muted} italic`}>
            Connected {day.format(new Date(c.createdAt))}, before these details
            were recorded.
          </span>
        ) : (
          <span className={muted}>
            {[
              c.redirectKind === "computer" && "Runs on a computer",
              c.redirectKind === "hosted" && c.redirectHost && (
                <>
                  Hosted service at{" "}
                  <b className="font-medium">{c.redirectHost}</b>
                </>
              ),
              c.approvedFrom &&
                `Approved from ${BROWSER[c.approvedFrom.browser]} on ${OS[c.approvedFrom.os]}, ${relativeTime(c.createdAt)}`,
            ]
              .filter(Boolean)
              .map((part, i, all) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed order
                <span key={i}>
                  {part}
                  {i < all.length - 1 ? " · " : ""}
                </span>
              ))}
          </span>
        )}
        <span className={muted}>
          {c.lastUsedAt
            ? `Last used ${relativeTime(c.lastUsedAt)}`
            : "Never used"}
          {versions > 0 &&
            ` · ${versions} ${versions === 1 ? "version" : "versions"} published`}
        </span>
      </div>
      <div className="flex flex-none items-center gap-[var(--oa-space-1)]">
        {canLabel && !c.label && !editing && (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-[length:var(--oa-text-sm)]"
            onClick={edit}
          >
            Add label
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`More for ${c.label ?? c.clientName}`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="currentColor"
              >
                <circle cx="3" cy="8" r="1.5" />
                <circle cx="8" cy="8" r="1.5" />
                <circle cx="13" cy="8" r="1.5" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="text-[length:var(--oa-text-sm)]"
          >
            {canLabel && c.label && (
              <DropdownMenuItem onSelect={edit}>Rename label</DropdownMenuItem>
            )}
            {versions > 0 && (
              <DropdownMenuItem asChild>
                <AppLink href={`/?agent=${encodeURIComponent(c.clientName)}`}>
                  View versions from {c.clientName}
                </AppLink>
              </DropdownMenuItem>
            )}
            {((canLabel && c.label) || versions > 0) && (
              <DropdownMenuSeparator />
            )}
            <DropdownMenuItem variant="destructive" onSelect={onRevoke}>
              Revoke…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
