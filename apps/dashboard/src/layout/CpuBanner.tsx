import { type Me, REPO_URL } from "@oa/shared";
import { useState } from "react";
import { AppLink } from "../library/AppLink";
import { CPU_DOC, PLANS_URL, useCpuSignals, utcDay } from "./cpu";
import { Notice } from "./Notice";

const DISMISSED_KEY = "oa.cpuBanner.dismissed";

const read = () => {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
};

export const ExtIcon = (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" />
  </svg>
);
const GaugeIcon = (
  <svg
    className="oa-cpu-ic"
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11.5l2.5-3.5" />
  </svg>
);

/**
 * Today's CPU-limit hits (3 or more), or a 1102 this tab just got. Dismissed for the
 * rest of the UTC day; gone on its own once today's count is back to 0.
 */
export function CpuBanner({
  role,
  plan,
  usageOff = false,
  className = "",
}: {
  role: Me["user"]["role"] | undefined;
  plan: Me["instance"]["plan"] | undefined;
  /** Hosted with usage_off: no usage read, no View usage. */
  usageOff?: boolean;
  /** The page's content column, so the banner's edges line up with it. */
  className?: string;
}) {
  const { admin, hits, recent, today, paid } = useCpuSignals(
    role,
    plan,
    usageOff,
  );
  const [dismissed, setDismissed] = useState(read);
  const n = hits ?? 0;
  if (role === "guest" || dismissed === today || !(n >= 3 || recent))
    return null;
  const first =
    n > 0
      ? `Your instance hit the limit ${n} ${n === 1 ? "time" : "times"} today, usually from bursts of large publishes.`
      : "A request just hit Cloudflare's free CPU limit.";
  const dismiss = () => {
    // The day it is now, not at the last render (the tab may have sat past midnight).
    const day = utcDay();
    try {
      localStorage.setItem(DISMISSED_KEY, day);
    } catch {}
    setDismissed(day);
  };
  const times = (k: number) => `${k} ${k === 1 ? "time" : "times"}`;
  // Workers Paid: no upgrade to pitch; a report helps instead.
  if (paid)
    return (
      <div className={`oa-cpu-banner ${className}`}>
        <Notice
          tone="warning"
          title="Some requests hit Cloudflare's CPU limit"
          icon={GaugeIcon}
          onDismiss={dismiss}
        >
          {/* Before today's count arrives: no number rather than a guess. */}
          <p>
            Your instance hit the 30-second per-request limit
            {n > 0 ? ` ${times(n)}` : ""} today. Retrying usually works. If it
            keeps happening, please report it so we can fix it.
          </p>
          <div className="oa-cpu-acts">
            {admin && !usageOff && (
              <AppLink
                className="oa-btn oa-sm oa-primary"
                href="/settings/usage"
              >
                View usage
              </AppLink>
            )}
            <a
              className="oa-cpu-link inline-flex items-center gap-1"
              href={`${REPO_URL}/issues/new`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Report an issue
              {ExtIcon}
            </a>
          </div>
        </Notice>
      </div>
    );
  return (
    <div className={`oa-cpu-banner ${className}`}>
      <Notice
        tone="warning"
        title="Some requests hit Cloudflare's free CPU limit"
        icon={GaugeIcon}
        onDismiss={dismiss}
      >
        <p>
          {first} Retrying generally works. Workers Paid ($5 a month) raises the
          limit to 30 seconds.
          {!admin && " Ask your instance owner about upgrading."}
        </p>
        <div className="oa-cpu-acts">
          {admin && (
            <a
              className="oa-btn oa-sm oa-primary"
              href={PLANS_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              See plans
              {ExtIcon}
            </a>
          )}
          <a
            className="oa-cpu-link"
            href={CPU_DOC}
            target="_blank"
            rel="noopener noreferrer"
          >
            Learn more<span className="oa-sr"> about the CPU limit</span>
          </a>
        </div>
      </Notice>
    </div>
  );
}
