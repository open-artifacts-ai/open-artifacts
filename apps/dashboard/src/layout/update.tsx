// "Update available" (Design's options A + B): the pieces the sidebar chip
// and the Settings → Instance Version card share. Admins only; there is no
// in-app upgrade, so Upgrade copies a prompt for the admin's AI agent.
import type { InstanceUpdate, Me } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useEffect, useState } from "react";
import { toast } from "./toast";

export const v = (version: string) => `v${version}`;

/** Whether this viewer is an owner or admin of a self-hosted install: who may see the Version card. */
export function isSelfHostAdmin(me: Me | null | undefined) {
  const role = me?.user.role;
  return (role === "owner" || role === "admin") && !me?.instance.hosted;
}

/** The update for owners and admins, else null (members, guests, no check yet). */
export function instanceUpdate(me: Me | null | undefined) {
  const role = me?.user.role;
  if (role !== "owner" && role !== "admin") return null;
  return me?.instance.update ?? null;
}

/** Whether to nudge: a newer release than this (non-custom) build. */
export const shouldNudge = (u: InstanceUpdate | null): u is InstanceUpdate =>
  Boolean(u?.updateAvailable && !u.custom);

/**
 * The prompt Upgrade copies; /upgrade.md is the served upgrade skill. With the
 * update it names both versions, and a breaking release or a custom build
 * tells the agent to explain first and wait for the owner's yes.
 */
export const upgradePrompt = (host = location.origin, u?: InstanceUpdate) => {
  if (!u)
    return `Upgrade my Open Artifacts instance at ${host}. Follow ${host}/upgrade.md`;
  const base = `Upgrade my Open Artifacts instance at ${host} from ${v(u.current)} to ${v(u.latestVersion)}. Follow ${host}/upgrade.md`;
  // Breaking first: a custom build can also be behind a breaking release.
  const breaking =
    u.breaking === true
      ? " This release has breaking changes: tell me what they mean for my instance and wait for my yes before you start."
      : "";
  const custom = u.custom
    ? ` This instance runs a custom build (${u.current}): tell me what upgrading will replace before you start.`
    : "";
  return `${base}${breaking}${custom}`;
};

export const COPIED = "Copied, paste this into your agent";
export const UPGRADE_GUIDE = "https://open-artifacts.com/docs/upgrade/";

const svg = (size: number, width: number, d: string) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const CopyIcon = () => svg(14, 2.2, "M9 9h12v12H9zM5 15V5a2 2 0 0 1 2-2h8");
const CheckIcon = () => svg(14, 2.6, "m5 12 5 5 9-10");
const ExternalIcon = () => svg(12, 2.2, "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6");
const WarningIcon = () =>
  svg(
    14,
    2,
    "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  );
export const ArrowIcon = () => svg(14, 2, "M5 12h14M13 6l6 6-6 6");

export const LINK =
  "inline-flex items-center gap-1 whitespace-nowrap text-[var(--oa-accent-fg)] underline underline-offset-2";

/** "Release notes", opening in a new tab and saying so. */
export function NotesLink({
  href,
  children = "Release notes",
}: {
  href: string;
  children?: string;
}) {
  return (
    <a className={LINK} href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalIcon />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

const NOTE = "m-0 text-[length:var(--oa-text-sm)]";

/** Above the buttons: breaking (true) warns, unknown (null) suggests the notes, false says nothing. */
export function BreakingNote({ update }: { update: InstanceUpdate }) {
  if (update.breaking === false) return null;
  if (update.breaking === null)
    return (
      <p className={`${NOTE} text-[var(--oa-text-muted)]`}>
        Check the release notes before upgrading.
      </p>
    );
  return (
    <p className={`${NOTE} flex items-start gap-[6px]`}>
      <span className="mt-[2px] text-[var(--oa-warning)]">
        <WarningIcon />
      </span>
      <span>
        Includes breaking changes. Read the{" "}
        <a
          className="text-[var(--oa-accent-fg)] underline underline-offset-2"
          href={update.notesUrl}
          target="_blank"
          rel="noreferrer"
        >
          release notes
          <span className="sr-only"> (opens in new tab)</span>
        </a>{" "}
        before upgrading.
      </span>
    </p>
  );
}

/**
 * Upgrade (copies the prompt; the icon turns to a check for 2 s) and Release
 * notes, then the confirmation: a polite status region, always in the DOM,
 * whose text shows for 4 s. `describedBy` names the line saying Upgrade
 * copies a prompt. Empty, the status takes no room (zero height, out of the
 * flow) but stays mounted: display:none would drop the live region.
 */
export function UpgradeActions({
  update,
  describedBy,
}: {
  update: InstanceUpdate;
  describedBy: string;
}) {
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const [icon, setIcon] = useState(false);
  useEffect(() => {
    if (copiedAt === null) return;
    const a = setTimeout(() => setIcon(false), 2000);
    const b = setTimeout(() => setCopiedAt(null), 4000);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [copiedAt]);
  const copy = () => {
    const failed = () =>
      toast({
        title: "Couldn't copy",
        description: "Select the prompt and copy it yourself.",
        tone: "danger",
      });
    if (!navigator.clipboard) return failed();
    navigator.clipboard.writeText(upgradePrompt()).then(() => {
      setIcon(true);
      setCopiedAt(Date.now());
    }, failed);
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]">
        <Button
          size="sm"
          className="text-[length:var(--oa-text-sm)]"
          aria-describedby={describedBy}
          onClick={copy}
        >
          {icon ? <CheckIcon /> : <CopyIcon />}
          Upgrade
        </Button>
        <NotesLink href={update.notesUrl} />
      </div>
      <div
        role="status"
        aria-live="polite"
        className={`flex items-center gap-[6px] text-[length:var(--oa-text-xs)] text-[var(--oa-success-fg)] empty:absolute empty:h-0 empty:w-px empty:overflow-hidden`}
      >
        {copiedAt !== null && (
          <>
            <CheckIcon />
            {COPIED}
          </>
        )}
      </div>
    </>
  );
}
