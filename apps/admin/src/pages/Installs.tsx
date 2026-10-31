import {
  type Attention,
  type InstallState,
  InstallStateSchema,
  type InstallSummary,
  type JobListItem,
  type World,
} from "@oa/shared/provisioning";
import {
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
import { usePaging } from "../hooks/usePaging";
import { LoadError } from "../layout/LoadError";

const TIER = { trial: "Trial", team: "Team", business: "Business" } as const;
export const SEARCH_DELAY_MS = 300;
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
  return (
    <>
      {STATE_LABEL[i.state]}
      {job && i.state === "active" && job.status !== "done" && (
        <span className="oa-mut">
          {JOB_VERB[job.kind].ing}
          {jobTarget(job.args) ? ` to ${jobTarget(job.args)}` : ""} ·{" "}
          {stepCount(job).n}/{stepCount(job).of}
        </span>
      )}
      {job && i.state === "provisioning" && (
        <span className="oa-mut">
          Creating · {stepCount(job).n}/{stepCount(job).of}
        </span>
      )}
      {i.state === "failed" && failedHere?.code && (
        <span className="oa-mut">{failedHere.code}</span>
      )}
    </>
  );
}

type SortKey = "slug" | "version" | "createdAt";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "slug", label: "Install" },
  { key: "version", label: "Release" },
  { key: "createdAt", label: "Created" },
];

export function Installs() {
  const world = useQuery(worldQuery());
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
  return (
    <>
      <div className="oa-head">
        <div style={{ flex: 1 }}>
          <h1>Installs</h1>
          {world.data && (
            <p className="oa-sub">
              {world.data.installs.total}{" "}
              {world.data.installs.total === 1 ? "install" : "installs"} on{" "}
              {world.data.env === "prod" ? "production" : "staging"}.
            </p>
          )}
        </div>
        <Link to="/installs/new" className="oa-cta">
          Create install
        </Link>
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
      <div className="oa-tools">
        <input
          type="search"
          aria-label="Search slug"
          placeholder="Search slug"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <label>
          <span className="sr-only">State</span>
          <select
            aria-label="State"
            value={state}
            onChange={(e) => {
              setState(e.target.value as InstallState | "");
              paging.reset();
            }}
          >
            <option value="">All states</option>
            {InstallStateSchema.options.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="oa-hint">Matches part of a slug, ignoring case.</p>
      {sort && list.data && list.data.items.length > 0 && (
        <p className="oa-hint">Sorted within this page only.</p>
      )}
      {list.isError ? (
        <LoadError
          title="Couldn't load installs"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : list.data && list.data.items.length === 0 ? (
        filtering ? (
          <p className="oa-placeholder">No installs match.</p>
        ) : (
          <div className="oa-placeholder">
            <p>
              <strong>No installs yet</strong>
            </p>
            <p>
              Create the first one. It runs as a job, and nothing is reachable
              until every check passes.
            </p>
          </div>
        )
      ) : list.data ? (
        <>
          <div className="oa-tablewrap">
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
                      <TableCell>{i.version ?? "–"}</TableCell>
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
                        i.state === "deleted"
                          ? "–"
                          : HEALTH_LABEL[i.health]}
                      </TableCell>
                      <TableCell>{fmtDay(i.createdAt)}</TableCell>
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
        onClick={() => set({ key: s.key, dir: on && sort.dir === 1 ? -1 : 1 })}
      >
        {s.label}
        {on && (sort.dir === 1 ? " ▲" : " ▼")}
      </button>
    </TableHead>
  );
}
