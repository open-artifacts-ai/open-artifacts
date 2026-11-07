// #1628: a one-line upgrade banner at the top of the dashboard for owners and
// admins (Design's look, OA Product's copy). The rules live in upgradeNotice;
// this renders them. The prompt isn't shown here: Copy plus the toast is the
// flow, and the chip popover and the Version card show the full text.
import type { InstanceUpdate, Me } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { XIcon } from "lucide-react";
import { useState } from "react";
import { Notice } from "./Notice";
import { toast } from "./toast";
import {
  COPIED,
  instanceUpdate,
  LINK,
  NotesLink,
  upgradePrompt,
  v,
} from "./update";
import {
  type DismissStore,
  dismissNotice,
  type NoticeVariant,
  sessionStore,
  upgradeNotice,
} from "./upgradeNotice";

/** localStorage, or the in-memory stand-in where it is blocked. */
const browserStore = (): DismissStore => {
  try {
    localStorage.getItem("oa.upgrade.probe");
    return localStorage;
  } catch {
    return sessionStore;
  }
};

const MONO = "font-mono text-[0.9em]";

function Line({ variant, u }: { variant: NoticeVariant; u: InstanceUpdate }) {
  const latest = <b className={`${MONO} font-medium`}>{v(u.latestVersion)}</b>;
  if (variant === "breaking")
    return (
      <>
        {latest} has breaking changes. Read the release notes before you
        upgrade.
      </>
    );
  if (variant === "custom")
    return (
      <>
        This is a custom build (<span className={MONO}>{u.current}</span>). The
        latest release is {latest}.
      </>
    );
  return (
    <>
      Open Artifacts {latest} is out. You're on{" "}
      <span className={MONO}>{v(u.current)}</span>.
    </>
  );
}

export function UpdateBanner({
  me,
  className = "",
}: {
  me: Me | null | undefined;
  /** The page's content column, so the banner's edges line up with it. */
  className?: string;
}) {
  const [, rerender] = useState(0);
  const update = instanceUpdate(me);
  const n = upgradeNotice(update, Date.now(), browserStore());
  if (!update || !n.show) return null;
  const copy = () => {
    const failed = () =>
      toast({
        title: "Couldn't copy",
        description: "Open Settings, Instance and copy the prompt there.",
        tone: "danger",
      });
    if (!navigator.clipboard) return failed();
    navigator.clipboard
      .writeText(upgradePrompt(location.origin, update))
      .then(() => toast({ title: COPIED, tone: "success" }), failed);
  };
  const hide = () => {
    dismissNotice(update, n.dismiss, Date.now(), browserStore());
    rerender((k) => k + 1);
  };
  return (
    <div
      data-testid="update-banner"
      className={`mb-[var(--oa-space-3)] ${className}`}
    >
      <Notice tone={n.variant === "breaking" ? "warning" : "info"} compact>
        {/* The text takes the first line or two on a phone; the actions drop to their own row. */}
        <div className="flex w-full flex-wrap items-center gap-x-[var(--oa-space-3)] gap-y-[var(--oa-space-2)] text-[length:var(--oa-text-sm)]">
          <span className="min-w-0 max-[600px]:basis-full">
            <Line variant={n.variant} u={update} />
          </span>
          <Button
            size="sm"
            variant="outline"
            className="min-h-8"
            onClick={copy}
          >
            Copy upgrade prompt
          </Button>
          <NotesLink href={update.notesUrl} />
          {n.dismiss === "remind" ? (
            <button type="button" className={`${LINK} ml-auto`} onClick={hide}>
              Remind me tomorrow
            </button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Hide until the next release"
              onClick={hide}
            >
              <XIcon aria-hidden="true" />
            </Button>
          )}
        </div>
      </Notice>
    </div>
  );
}
