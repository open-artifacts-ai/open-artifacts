import type { Usage as UsageData } from "@oa/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@oa/ui/shadcn";
import { useUsage } from "../api/queries";
import { useMe } from "../auth/useMe";
import { ExtIcon } from "../layout/CpuBanner";
import { COSTS_DOC, PRICING_URL } from "../layout/cpu";
import { Notice } from "../layout/Notice";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import {
  CARD,
  Code,
  GAP,
  INSET,
  MEASURE,
  muted,
  SettingsCard,
  STACK,
} from "./ui";

type Tone = "normal" | "warning" | "danger";
type Metric = UsageData["metrics"][number];

const LABELS: Record<Metric["key"], { name: string; what: string }> = {
  requests: { name: "Worker requests", what: "Views, uploads, agent calls" },
  d1_reads: { name: "D1 rows read", what: "Library, search, listings" },
  d1_writes: { name: "D1 rows written", what: "Publishes, shares, settings" },
  do_requests: {
    name: "Durable Object requests",
    what: "Live-page data and sync",
  },
  cpu_limit_hits: {
    name: "CPU limit hits",
    what: "Requests stopped by the CPU limit",
  },
  cpu_p99_ms: { name: "CPU time p99 (ms)", what: "Slowest 1% of requests" },
  kv_writes: { name: "KV writes", what: "Agent sign-ins and token refreshes" },
};
/** The old @oa/ui Badge tones, on shadcn's Badge. */
const BADGE: Record<Tone, string> = {
  normal: "bg-[var(--oa-sunken)] text-[var(--oa-text-2)]",
  warning: "bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]",
  danger: "bg-[var(--oa-danger-soft)] text-[var(--oa-danger)]",
};
const FILL: Record<Tone, string> = {
  normal: "bg-[var(--oa-text-2)]",
  warning: "bg-[var(--oa-warning)]",
  danger: "bg-[var(--oa-danger)]",
};
const TEXT: Record<Tone, string> = {
  normal: "",
  warning: "text-[var(--oa-warning)]",
  danger: "text-[var(--oa-danger)]",
};
/** Two columns of cards, one at <= 600px. */
const GRID = "grid grid-cols-2 gap-[var(--oa-space-4)] max-[600px]:grid-cols-1";
const BIG =
  "text-[length:var(--oa-text-2xl)] font-semibold leading-[1.2] tracking-[-0.02em] tabular-nums";
const LINK =
  "inline-flex items-center gap-[var(--oa-space-1)] whitespace-nowrap rounded-sm font-medium text-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring";

/** A bar of `pct` (clamped) in `tone`; a styled div since <meter> can't be toned. */
function Track({
  pct,
  tone,
  thin = false,
  label,
  max,
  now,
  text,
}: {
  pct: number;
  tone: Tone;
  thin?: boolean;
  label: string;
  max: number;
  now: number;
  text: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled per tone cross-browser
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={now}
      aria-valuetext={text}
      data-tone={tone}
      className={`relative overflow-hidden rounded-full bg-[var(--oa-sunken)] shadow-[inset_0_0_0_1px_var(--oa-divider)] ${thin ? "h-1" : "h-2"}`}
    >
      <i
        className={`absolute inset-y-0 left-0 rounded-full ${FILL[tone]}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

/**
 * Raw percent of the limit. Negative use counts as 0; a limit of 0 (or less) with any
 * use is over the limit (Infinity), with none it is 0. Never NaN.
 */
export const percent = (used: number, limit: number) => {
  if (!(used > 0)) return 0;
  return limit > 0 ? (used / limit) * 100 : Number.POSITIVE_INFINITY;
};
export const toneOf = (pct: number): Tone =>
  pct >= 95 ? "danger" : pct >= 80 ? "warning" : "normal";
const fmt = (n: number) => n.toLocaleString("en-US");

/** Per-request CPU numbers: shown in their own card, never as daily meters. */
const CPU_KEYS: ReadonlySet<Metric["key"]> = new Set([
  "cpu_limit_hits",
  "cpu_p99_ms",
]);
/** CPU time: milliseconds, or seconds from 1 s (Workers Paid's 30 s cap). */
const ms = (n: number) =>
  n >= 1000
    ? `${Number((n / 1000).toFixed(1))} s`
    : `${Number(n.toFixed(1))} ms`;

function CpuCard({ metrics }: { metrics: Metric[] }) {
  const hitsM = metrics.find((m) => m.key === "cpu_limit_hits");
  const p99M = metrics.find((m) => m.key === "cpu_p99_ms");
  if (!hitsM && !p99M) return null;
  const idle = metrics.every((m) => !(m.used > 0));
  return (
    <section aria-labelledby="oa-cpu-h" className="min-w-0">
      <Card className={CARD}>
        <CardHeader
          className={`flex min-h-[30px] flex-wrap items-baseline gap-x-[var(--oa-space-2)] ${INSET}`}
        >
          <CardTitle>
            <h2
              id="oa-cpu-h"
              className="text-[length:var(--oa-text-md)] font-semibold"
            >
              CPU
            </h2>
          </CardTitle>
          <span className={muted}>A per-request limit, not a daily quota</span>
        </CardHeader>
        <CardContent
          className={`grid grid-cols-2 gap-x-[var(--oa-space-8)] gap-y-[var(--oa-space-4)] max-[600px]:grid-cols-1 ${INSET}`}
        >
          {hitsM && <HitsRow hits={Math.max(hitsM.used, 0)} />}
          {p99M && <P99Row metric={p99M} idle={idle} />}
        </CardContent>
      </Card>
    </section>
  );
}

const ROW = `flex min-w-0 flex-col ${GAP}`;
const ROW_H =
  "text-[length:var(--oa-text-xs)] font-medium text-[var(--oa-text-2)]";
const SMALL =
  "text-[length:var(--oa-text-sm)] font-normal tracking-normal text-muted-foreground";

function HitsRow({ hits }: { hits: number }) {
  return (
    <div className={ROW} data-tone={hits >= 3 ? "warning" : "normal"}>
      <h3 className={ROW_H}>Requests over the CPU limit today</h3>
      <div className={`${BIG} ${hits >= 3 ? TEXT.warning : ""}`}>
        {fmt(hits)}
      </div>
      <p className={muted}>
        {hits > 0
          ? "These requests were stopped with Cloudflare error 1102. Retrying usually works."
          : "No request was stopped for using too much CPU."}
      </p>
    </div>
  );
}

function P99Row({ metric, idle }: { metric: Metric; idle: boolean }) {
  const used = Math.max(metric.used, 0);
  const { limit } = metric;
  const pct = percent(used, limit);
  // A limit of 0 means no per-request cap to measure against (Workers Paid).
  const tone: Tone =
    limit > 0 && pct >= 100
      ? "danger"
      : limit > 0 && pct >= 80
        ? "warning"
        : "normal";
  return (
    <div className={ROW}>
      <h3 className={ROW_H}>Typical busy request (p99)</h3>
      {idle ? (
        <div className={BIG}>
          <small className={SMALL}>No requests yet today</small>
        </div>
      ) : (
        <>
          <div className={BIG}>
            {ms(used)}{" "}
            {limit > 0 && <small className={SMALL}>of {ms(limit)}</small>}
          </div>
          {limit > 0 && (
            <Track
              thin
              pct={pct}
              tone={tone}
              label="p99 CPU time"
              max={limit}
              now={Math.min(used, limit)}
              text={`${ms(used)} of ${ms(limit)}`}
            />
          )}
        </>
      )}
    </div>
  );
}

/** The plan positioning line, for the people who can change the plan. */
function PlanLine({ plan }: { plan: "free" | "paid" | undefined }) {
  const me = useMe();
  const role = me.status === "authed" ? me.me.user.role : null;
  if (role !== "owner" && role !== "admin") return null;
  if (plan === "paid")
    return (
      <p className="text-[length:var(--oa-text-sm)] text-[var(--oa-text-2)]">
        This instance is on Workers Paid. There are no daily limits, and each
        request gets up to 30 seconds of CPU. Usage beyond what the plan
        includes is billed by Cloudflare.{" "}
        <a
          className={LINK}
          href={PRICING_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          See pricing
          {ExtIcon}
        </a>
      </p>
    );
  return (
    <p className="text-[length:var(--oa-text-sm)] text-[var(--oa-text-2)]">
      Workers Free is sized for one person. Workers Paid ($5 a month) is sized
      for a team: it sends invite emails and gives each request up to 30 seconds
      of CPU.{" "}
      <a
        className={LINK}
        href={COSTS_DOC}
        target="_blank"
        rel="noopener noreferrer"
      >
        Compare plans
        {ExtIcon}
      </a>
    </p>
  );
}

function Meter({ metric }: { metric: Metric }) {
  const { name, what } = LABELS[metric.key];
  const used = Math.max(metric.used, 0);
  // A limit of 0 is no daily cap (Workers Paid): the count, no bar or cap.
  // The description sits where the bar was, in a slot as tall as the bar and
  // the foot, so the card is as tall as a capped one.
  if (!(metric.limit > 0))
    return (
      <SettingsCard id={`oa-meter-${metric.key}`} title={name}>
        <div className="flex flex-wrap items-baseline gap-[var(--oa-space-2)] tabular-nums">
          <b className={BIG}>{fmt(used)}</b>
          <span className="text-muted-foreground">today</span>
        </div>
        <div className="relative">
          <div aria-hidden="true" className={`invisible grid ${GAP}`}>
            <div className="h-2" />
            <p className={muted}>&nbsp;</p>
          </div>
          <p className={`absolute inset-x-0 top-0 ${muted}`}>{what}</p>
        </div>
      </SettingsCard>
    );
  const pct = percent(used, metric.limit);
  const tone = toneOf(pct);
  const reached = pct >= 100;
  const shown = pct > 100 ? "100%+" : `${Math.floor(pct)}%`;
  const left = Math.max(metric.limit - used, 0);
  const state = reached
    ? "limit reached"
    : tone === "danger"
      ? "near limit"
      : tone === "warning"
        ? "high"
        : "";
  const badge = reached
    ? "Limit reached"
    : state
      ? `${shown} · ${state}`
      : shown;
  const id = `oa-meter-${metric.key}`;
  return (
    <SettingsCard
      id={id}
      title={name}
      action={<Badge className={`rounded-sm ${BADGE[tone]}`}>{badge}</Badge>}
    >
      <div className="flex flex-wrap items-baseline gap-[var(--oa-space-2)] tabular-nums">
        <b className={BIG}>{fmt(used)}</b>
        <span className="text-muted-foreground">
          / {fmt(metric.limit)} today
        </span>
      </div>
      <Track
        pct={pct}
        tone={tone}
        label={name}
        max={Math.max(metric.limit, 0)}
        now={Math.min(used, Math.max(metric.limit, 0))}
        text={`${fmt(used)} of ${fmt(metric.limit)}${state ? `, ${state}` : ""}`}
      />
      <div
        className={`flex flex-wrap justify-between gap-[var(--oa-space-2)] ${muted}`}
      >
        <span>{what}</span>
        <span className={TEXT[tone]}>{fmt(left)} left</span>
      </div>
    </SettingsCard>
  );
}

function Setup() {
  return (
    <SettingsCard
      id="oa-setup-h"
      title="Connect Cloudflare analytics to see usage"
    >
      <p>
        Open Artifacts reads today's numbers from Cloudflare's GraphQL Analytics
        API. It needs a read-only token with the Account Analytics permission,
        stored as the <code>ANALYTICS_TOKEN</code> Worker secret. Everything
        else works without it.
      </p>
      <p>
        Run setup and paste the token when prompted (it asks for{" "}
        <code>ANALYTICS_TOKEN</code>):
      </p>
      <Code code="pnpm oa:setup" label="Copy setup command" />
      <p>Or store it directly:</p>
      <Code
        code="wrangler secret put ANALYTICS_TOKEN"
        label="Copy wrangler command"
      />
      <p>Then reload this page. The token is never shown in the dashboard.</p>
    </SettingsCard>
  );
}

/** D4 banners: one per metric at or past the danger threshold, or the empty state. */
function alerts(metrics: Metric[]) {
  if (metrics.every((m) => !(m.used > 0)))
    return (
      <Notice tone="info" title="No usage recorded yet today.">
        Cloudflare's analytics can lag a few minutes behind real traffic.
      </Notice>
    );
  return metrics
    .filter((m) => m.limit > 0 && toneOf(percent(m.used, m.limit)) === "danger")
    .map((m) => {
      const pct = percent(m.used, m.limit);
      const name = LABELS[m.key].name;
      return (
        <Notice
          key={m.key}
          tone="danger"
          title={
            pct >= 100
              ? `${name} have reached today's limit.`
              : `${name} are at ${Math.floor(pct)}% of today's limit.`
          }
        >
          Past the limit, writes fail until 00:00 UTC.
        </Notice>
      );
    });
}

export function Usage() {
  useDocumentTitle("Usage");
  const q = useUsage();
  return (
    // The 880px measure of the other settings pages.
    <div className={`${MEASURE} ${STACK}`}>
      <div className="flex items-center gap-[var(--oa-space-3)]">
        <h1 className="flex-none text-[length:var(--oa-text-xl)] font-semibold">
          Usage
        </h1>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
        >
          Refresh
        </Button>
      </div>
      <PlanLine plan={q.data?.plan} />
      {q.isError ? (
        <Notice
          tone="danger"
          title="Couldn't load usage."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void q.refetch()}
            >
              Retry
            </Button>
          }
        >
          This doesn't affect your artifacts.
        </Notice>
      ) : !q.data ? (
        <div className={GRID} aria-busy="true">
          <span className="sr-only">Loading…</span>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[148px] rounded-xl" />
          ))}
        </div>
      ) : !q.data.available ? (
        <Setup />
      ) : (
        <>
          {alerts(q.data.metrics.filter((m) => !CPU_KEYS.has(m.key)))}
          <p className={muted}>
            Today, {q.data.date}. Resets at 00:00 UTC. Cloudflare's numbers are
            cached for 5 minutes.
          </p>
          <div className={GRID}>
            {q.data.metrics
              .filter((m) => !CPU_KEYS.has(m.key))
              .map((m) => (
                <Meter key={m.key} metric={m} />
              ))}
          </div>
          <CpuCard metrics={q.data.metrics} />
        </>
      )}
    </div>
  );
}
