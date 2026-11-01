import {
  type Attention,
  type InstallState,
  InstallStateSchema,
  type InstallSummary,
  type JobListItem,
  type World,
} from "@oa/shared/provisioning";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { installsQuery, worldQuery } from "../api/queries";
import { Pager } from "../components/Bits";
import {
  fmtClock,
  fmtDay,
  HEALTH_LABEL,
  JOB_VERB,
  jobTarget,
  STATE_LABEL,
  stepCount,
} from "../components/labels";
import { useEnv } from "../hooks/useEnv";
import { usePaging } from "../hooks/usePaging";
import { LoadError } from "../layout/LoadError";

const TIER = { trial: "Trial", team: "Team", business: "Business" } as const;
export const SEARCH_DELAY_MS = 300;
/** The state filter's "any state" value (Radix Select has no empty value). */
const ALL = "all";
const ALERT_LABEL: Record<string, string> = {
  job_failed: "Job failed",
  install_failed: "Create failed",
  health_failing: "Health failing",
  mismatch: "Routing mismatch",
};
const sentence = (kind: string) => {
  const t = kind.replaceAll("_", " ");
  return t[0].toUpperCase() + t.slice(1);
};

function Tiles({ world }: { world: World }) {
  const by = world.installs.byState;
  const attention = world.attention.length;
  const tok = world.provisioningToken;
  return (
    <section className="oa-tiles" aria-label="Overview">
      <div className="oa-tile" data-testid="tile-active">
        <div className="k">Active</div>
        <div className="v">{by.active}</div>
      </div>
      <div className="oa-tile" data-testid="tile-creating">
        <div className="k">Creating</div>
        <div className="v">{by.provisioning}</div>
      </div>
      <div className="oa-tile" data-testid="tile-paused">
        <div className="k">Paused · Deleting</div>
        <div className="v">
          {by.suspended} <small>·</small> {by.deleting}
        </div>
      </div>
      <div
        className={`oa-tile ${attention > 0 ? "warn" : ""}`}
        data-testid="tile-attention"
      >
        <div className="k">Needs attention</div>
        <div className="v">{attention}</div>
      </div>
      <div
        className={`oa-tile ${tok.status === "active" ? "" : "warn"}`}
        data-testid="tile-token"
      >
        <div className="k">Provisioning token</div>
        <div className="v">
          {tok.status === "invalid"
            ? "Not working"
            : tok.daysLeft === null
              ? "No end date"
              : tok.daysLeft}{" "}
          {tok.daysLeft !== null && tok.status !== "invalid" && (
            <small>days left</small>
          )}
        </div>
      </div>
      <div className="oa-tile" data-testid="tile-prodclean">
        <div className="k">Prod clean</div>
        <div className="v">
          {world.prodClean ? (
            <>
              {fmtClock(world.prodClean.at)}{" "}
              <small>{world.prodClean.ok ? "passed" : "failed"}</small>
            </>
          ) : (
            <small>never run</small>
          )}
        </div>
      </div>
    </section>
  );
}

/** What the State cell says: the label, then what a running job or an alert adds. */
function StateCell({
  i,
  job,
  alerts,
}: {
  i: InstallSummary;
  job: JobListItem | undefined;
  alerts: Attention[];
}) {
  const failedHere = alerts.find((a) => a.kind === "job_failed" && a.code);
  const step = job ? stepCount(job) : null;
  const bar = step && (
    <span className="oa-mini" aria-hidden="true">
      <b style={{ width: `${step.of ? (100 * step.n) / step.of : 0}%` }} />
    </span>
  );
  return (
    <>
      <span className="oa-st" data-tone={STATE_TONE[i.state]}>
        {STATE_LABEL[i.state]}
      </span>
      {job && step && i.state === "active" && job.status !== "done" && (
        <span className="oa-chip oa-chip-accent">
          {JOB_VERB[job.kind].ing}
          {jobTarget(job.args) ? ` to ${jobTarget(job.args)}` : ""} · {step.n}/
          {step.of}
          {bar}
        </span>
      )}
      {step && i.state === "provisioning" && (
        <span className="oa-chip oa-chip-accent">
          Creating · {step.n}/{step.of}
          {bar}
        </span>
      )}
      {i.state === "failed" && failedHere?.code && (
        <span className="oa-chip oa-chip-danger">{failedHere.code}</span>
      )}
    </>
  );
}

const STATE_TONE = {
  provisioning: "accent",
  active: "success",
  suspended: "warning",
  deleting: "muted",
  deleted: "muted",
  failed: "danger",
} as const satisfies Record<InstallState, string>;
const HEALTH_TONE = {
  ok: "success",
  failing: "danger",
  unknown: "muted",
} as const satisfies Record<keyof typeof HEALTH_LABEL, string>;

type SortKey = "slug" | "version" | "createdAt";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "slug", label: "Install" },
  { key: "version", label: "Release" },
  { key: "createdAt", label: "Created" },
];

export function Installs() {
  const world = useQuery(worldQuery());
  const env = useEnv();
  const [state, setState] = useState<InstallState | "">("");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const paging = usePaging();
  // The search runs on the server (R2 `q`) once typing pauses.
  useEffect(() => {
    const next = typed.trim();
    // Nothing typed yet (or back to the applied search): leave the page alone.
    // Resetting here would undo a Next click made before the first tick.
    if (next === q) return;
    const t = setTimeout(() => {
      setQ(next);
      paging.reset();
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [typed, q, paging.reset]);
  const list = useQuery(
    installsQuery({
      cursor: paging.cursor,
      state: state || undefined,
      q: q || undefined,
    }),
  );
  const jobs = useMemo(
    () =>
      new Map((world.data?.jobs.recent ?? []).map((j) => [j.id, j] as const)),
    [world.data],
  );
  const rows = useMemo(() => {
    const items = [...(list.data?.items ?? [])];
    if (!sort) return items;
    return items.sort((a, b) => {
      const av = a[sort.key] ?? "";
      const bv = b[sort.key] ?? "";
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
  }, [list.data, sort]);
  const filtering = !!state || !!q || paging.canPrev;
  // Nothing to search or filter yet: the empty card carries the next step.
  const none =
    !filtering && list.data?.items.length === 0 && !list.data.nextCursor;
  return (
    <>
      <div className="oa-head">
        <div>
          <h1>Installs</h1>
          {world.data && (
            <p className="oa-sub">
              {world.data.installs.total}{" "}
              {world.data.installs.total === 1 ? "install" : "installs"} on{" "}
              {(env ?? world.data.env) === "prod" ? "production" : "staging"}.
            </p>
          )}
        </div>
      </div>
      {world.data && (
        <>
          <Tiles world={world.data} />
          {world.data.truncated && (
            <p className="oa-note">The overview shows the newest 50 items.</p>
          )}
        </>
      )}
      {world.isError && (
        <LoadError
          title="Couldn't load the overview"
          error={world.error}
          onRetry={() => void world.refetch()}
        />
      )}
      {!none && (
        <div className="oa-tools oa-list-tools">
          <span className="oa-search">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3l3 3" />
            </svg>
            <input
              type="search"
              aria-label="Search slug or host"
              placeholder="Search slug or host"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </span>
          <Select
            value={state || ALL}
            onValueChange={(v) => {
              setState(v === ALL ? "" : (v as InstallState));
              paging.reset();
            }}
          >
            <SelectTrigger aria-label="State" className="oa-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value={ALL}>All states</SelectItem>
              {InstallStateSchema.options.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATE_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="oa-spacer" />
          <Link to="/installs/new" className="oa-cta">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 3v10M3 8h10" />
            </svg>
            Create install
          </Link>
        </div>
      )}
      {list.isError ? (
        <LoadError
          title="Couldn't load installs"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : list.data && list.data.items.length === 0 ? (
        filtering ? (
          <div className="oa-card oa-empty">
            <p>No installs match.</p>
          </div>
        ) : (
          <div className="oa-card oa-empty">
            <p>
              <strong>No installs yet</strong>
            </p>
            <p>
              Create the first one. It runs as a job, and nothing is reachable
              until every check passes.
            </p>
            <Link to="/installs/new" className="oa-cta oa-empty-cta">
              Create install
            </Link>
          </div>
        )
      ) : list.data ? (
        <>
          <div className="oa-tablewrap oa-installs">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead s={SORTS[0]} sort={sort} set={setSort} />
                  <SortHead s={SORTS[1]} sort={sort} set={setSort} />
                  <TableHead>Tier</TableHead>
                  <TableHead>Sign-in</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Health</TableHead>
                  <SortHead s={SORTS[2]} sort={sort} set={setSort} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((i) => {
                  const alerts = (world.data?.attention ?? []).filter(
                    (a) => a.installId === i.id,
                  );
                  return (
                    <TableRow key={i.id}>
                      <TableCell>
                        <Link to="/installs/$id" params={{ id: i.id }}>
                          {i.slug}
                        </Link>
                        <span className="oa-mut">{i.appHost}</span>
                      </TableCell>
                      <TableCell className="oa-mono">
                        {i.version ?? "–"}
                      </TableCell>
                      <TableCell>{i.tier ? TIER[i.tier] : "–"}</TableCell>
                      <TableCell>
                        {i.auth.providers
                          .map((p) => (p === "google" ? "Google" : "Email"))
                          .join(" · ")}
                        {i.auth.domainCount > 0 &&
                          ` · ${i.auth.domainCount} ${i.auth.domainCount === 1 ? "domain" : "domains"}`}
                      </TableCell>
                      <TableCell data-testid="state">
                        <StateCell
                          i={i}
                          job={
                            i.activeJobId ? jobs.get(i.activeJobId) : undefined
                          }
                          alerts={alerts}
                        />
                        {alerts
                          .filter(
                            (a) =>
                              !(
                                i.state === "failed" &&
                                (a.kind === "job_failed" ||
                                  a.kind === "install_failed")
                              ),
                          )
                          .map((a) => (
                            <span
                              key={`${a.kind}:${a.since}`}
                              className={`oa-chip ${a.kind === "job_failed" || a.kind === "health_failing" ? "oa-chip-danger" : ""}`}
                              title={a.message ?? undefined}
                            >
                              {ALERT_LABEL[a.kind] ?? sentence(a.kind)}
                            </span>
                          ))}
                      </TableCell>
                      <TableCell>
                        {i.state === "provisioning" ||
                        i.state === "failed" ||
                        i.state === "deleting" ||
                        i.state === "deleted" ? (
                          <span className="oa-note">–</span>
                        ) : (
                          <span
                            className="oa-st"
                            data-tone={HEALTH_TONE[i.health]}
                          >
                            {HEALTH_LABEL[i.health]}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="oa-note">
                        {fmtDay(i.createdAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <Pager
            canPrev={paging.canPrev}
            next={list.data.nextCursor}
            onPrev={paging.prev}
            onNext={paging.next}
          />
        </>
      ) : null}
    </>
  );
}

function SortHead({
  s,
  sort,
  set,
}: {
  s: { key: SortKey; label: string };
  sort: { key: SortKey; dir: 1 | -1 } | null;
  set: (v: { key: SortKey; dir: 1 | -1 } | null) => void;
}) {
  const on = sort?.key === s.key;
  return (
    <TableHead
      aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="oa-th"
        title={on ? "Sorted within this page only." : undefined}
        onClick={() => set({ key: s.key, dir: on && sort.dir === 1 ? -1 : 1 })}
      >
        {s.label}
        {on && (sort.dir === 1 ? " ▲" : " ▼")}
      </button>
    </TableHead>
  );
}
