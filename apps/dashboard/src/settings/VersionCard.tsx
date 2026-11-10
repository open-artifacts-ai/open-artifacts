import type { InstanceUpdate } from "@oa/shared";
import { Badge, Button } from "@oa/ui/shadcn";
import { useEffect, useState } from "react";
import { toast } from "../layout/toast";
import {
  BreakingNote,
  COPIED,
  shouldNudge,
  UPGRADE_GUIDE,
  UpgradeActions,
  upgradePrompt,
  v,
} from "../layout/update";
import { relativeTime } from "../library/time";
import { SettingsCard } from "./ui";

const KV =
  "m-0 grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-[var(--oa-space-4)] gap-y-[10px] text-[length:var(--oa-text-sm)] max-[600px]:grid-cols-[96px_minmax(0,1fr)]";
const DT = "text-[var(--oa-text-2)]";
const DD = "m-0 flex min-w-0 flex-wrap items-center gap-x-[var(--oa-space-2)]";
const MONO = "font-mono text-[length:var(--oa-text-sm)]";
const MUTED = "m-0 text-[length:var(--oa-text-sm)] text-[var(--oa-text-muted)]";

/** The always-on path: shown when there is no nudge. Copy reuses upgradePrompt(). */
function UpgradeLine() {
  const host = location.origin;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    const failed = () =>
      toast({
        title: "Couldn't copy",
        description: "Select the prompt and copy it yourself.",
        tone: "danger",
      });
    if (!navigator.clipboard) return failed();
    navigator.clipboard.writeText(upgradePrompt()).then(() => {
      setCopied(true);
    }, failed);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-[var(--oa-space-3)] gap-y-[var(--oa-space-2)]">
      <p id="oa-upgrade-line" className={MUTED}>
        To upgrade, tell your agent: Follow{" "}
        <a
          className={`${MONO} text-[var(--oa-accent-fg)] underline underline-offset-2`}
          href={`${host}/upgrade.md`}
          target="_blank"
          rel="noopener"
        >
          {host}/upgrade.md
          <span className="sr-only"> (opens in new tab)</span>
        </a>
      </p>
      <Button
        variant="outline"
        size="sm"
        className="text-[length:var(--oa-text-sm)]"
        aria-describedby="oa-upgrade-line"
        onClick={copy}
      >
        {copied ? "Copied" : "Copy prompt"}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? COPIED : ""}
      </span>
    </div>
  );
}

/** Settings → Instance: running vs latest release, the upgrade prompt when newer, else an always-on upgrade line. */
export function VersionCard({ update }: { update: InstanceUpdate | null }) {
  if (!update)
    return (
      <SettingsCard id="oa-version" title="Version">
        <UpgradeLine />
      </SettingsCard>
    );
  const nudge = shouldNudge(update);
  return (
    <SettingsCard id="oa-version" title="Version">
      <dl className={KV}>
        <dt className={DT}>Running</dt>
        <dd className={DD}>
          <span className={MONO}>{v(update.current)}</span>
          {update.custom && <Badge variant="outline">Custom build</Badge>}
        </dd>
        <dt className={DT}>Latest release</dt>
        <dd className={DD}>
          {update.custom || update.updateAvailable ? (
            <>
              <span className={MONO}>{v(update.latestVersion)}</span>
              {nudge && (
                <Badge className="bg-brand-soft text-brand-soft-foreground">
                  Update available
                </Badge>
              )}
            </>
          ) : (
            "You're on the latest version"
          )}
        </dd>
        <dt className={DT}>Checked</dt>
        <dd className={`${DD} text-[var(--oa-text-2)]`}>
          {relativeTime(update.checkedAt)}
        </dd>
      </dl>
      {update.custom && (
        <p className={MUTED}>
          This is a custom build, so it isn't upgraded from here. To move to a
          release, follow the{" "}
          <a
            className="text-[var(--oa-accent-fg)] underline underline-offset-2"
            href={UPGRADE_GUIDE}
            target="_blank"
            rel="noreferrer"
          >
            upgrade guide
            <span className="sr-only"> (opens in new tab)</span>
          </a>
          .
        </p>
      )}
      {nudge && (
        <div className="mt-[var(--oa-space-1)] grid gap-[var(--oa-space-3)] border-0 border-t border-solid border-border pt-[var(--oa-space-4)]">
          <div className="grid gap-[2px]">
            <h3 className="m-0 text-[length:var(--oa-text-sm)] font-semibold">
              Upgrade to {v(update.latestVersion)}
            </h3>
            <p
              id="oa-upgrade-help"
              className="m-0 text-[length:var(--oa-text-sm)] text-[var(--oa-text-2)]"
            >
              Upgrade copies this prompt. Paste it into any AI agent that can
              run commands in your install directory. Your artifacts and data
              are kept.
            </p>
          </div>
          <p className="m-0 select-text whitespace-pre-wrap rounded-[var(--oa-radius-md)] bg-[var(--oa-sunken)] px-[var(--oa-space-3)] py-[10px] font-mono text-[12.5px] leading-[1.55] text-[var(--oa-text-2)]">
            {upgradePrompt()}
          </p>
          <BreakingNote update={update} />
          <UpgradeActions update={update} describedBy="oa-upgrade-help" />
        </div>
      )}
      {!nudge && !update.custom && <UpgradeLine />}
    </SettingsCard>
  );
}
