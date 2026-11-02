import {
  type Attention,
  type InstallState,
  InstallStateSchema,
  type InstallSummary,
  type JobListItem,
  type World,
} from "@oa/shared/provisioning";
import {
  Input,
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
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { installsQuery, worldQuery } from "../api/queries";
import { Pager } from "../components/Bits";
import {
  alertLabel,
  fmtClock,
  fmtDay,
  HEALTH_LABEL,
  HEALTH_TONE,
  JOB_VERB,
  jobTarget,
  providerLabel,
  STATE_LABEL,
  STATE_TONE,
  stepCount,
  TIER_LABEL,
} from "../components/labels";
import { useEnv } from "../hooks/useEnv";
import { usePaging } from "../hooks/usePaging";
import { LoadError } from "../layout/LoadError";

export const SEARCH_DELAY_MS = 300;
/** The state filter's "any state" value (Radix Select has no empty value). */
const ALL = "all";
/**
 * The list filter in the URL (`?state=`): an install state, sent as R2
 * `state`, or "attention", which R2 has no param for. That one lists the
 * loaded page's installs that appear in the world's attention list.
 */
export const ATTENTION = "attention";
export type StateFilter = InstallState | typeof ATTENTION;
export const parseStateFilter = (v: unknown): StateFilter | undefined =>
  v === ATTENTION || InstallStateSchema.safeParse(v).success
    ? (v as StateFilter)
    : undefined;

type TileDef = { f: StateFilter; label: string; n: number; id: string };

/** One status tile that filters the list; pressed while it is the filter. */
function TileButton({
  t,
  filter,
  onPick,
  className = "oa-tile oa-tile-btn",
}: {
  t: TileDef;
  filter: StateFilter | undefined;
  onPick: (f: StateFilter | undefined) => void;
  className?: string;
}) {
  const on = filter === t.f;
  return (
    <button
      type="button"
      className={`${className} ${t.f === ATTENTION && t.n > 0 ? "warn" : ""}`}
      data-testid={t.id}
      aria-pressed={on}
      onClick={() => onPick(on ? undefined : t.f)}
    >
      <span className="k">{t.label}</span>
      <span className="v">{t.n}</span>
    </button>
  );
}

function Tiles({
  world,
  filter,
  onPick,
}: {
  world: World;
  filter: StateFilter | undefined;
  onPick: (f: StateFilter | undefined) => void;
}) {
  const by = world.installs.byState;
  // Installs, not alerts: one install with two alerts counts once.
  const attention = new Set(world.attention.map((a) => a.installId)).size;
  const tok = world.provisioningToken;
  const tile = (t: TileDef) => (
    <TileButton key={t.f} t={t} filter={filter} onPick={onPick} />
  );
  return (
    <section className="oa-tiles" aria-label="Overview">
      {tile({ f: "active", label: "Active", n: by.active, id: "tile-active" })}
      {tile({
        f: "provisioning",
        label: "Creating",
        n: by.provisioning,
        id: "tile-creating",
      })}
      {/* Paused and Deleted, restorable: one tile, each half filters on its own. */}
      <div className="oa-tile oa-tile-split">
        <TileButton
          t={{
            f: "suspended",
            label: "Paused",
            n: by.suspended,
            id: "tile-paused",
          }}
          filter={filter}
          onPick={onPick}
          className="oa-tile-seg"
        />
        <TileButton
          t={{
            f: "deleting",
            label: STATE_LABEL.deleting,
            n: by.deleting,
            id: "tile-deleting",
          }}
          filter={filter}
          onPick={onPick}
          className="oa-tile-seg"
        />
      </div>
      {tile({
        f: ATTENTION,
        label: "Needs attention",
        n: attention,
        id: "tile-attention",
      })}
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
        <span className="oa-chip oa-chip-danger oa-code">
          {failedHere.code}
        </span>
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
  const env = useEnv();
  const navigate = useNavigate();
  const filter = parseStateFilter(
    (useSearch({ strict: false }) as { state?: unknown }).state,
  );
  const state = filter === ATTENTION ? undefined : filter;
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  // Keyed on the filter and search: a new one starts at page 1 in the same
  // render, whether picked here or by Back/Forward, so no cursor from the old
  // filter is ever sent with the new one.
  const paging = usePaging(`${filter ?? ""}\u0000${q}`);
  const setFilter = (f: StateFilter | undefined) => {
    void navigate({ to: "/installs", search: f ? { state: f } : {} });
  };
  // The search runs on the server (R2 `q`) once typing pauses.
  useEffect(() => {
    const next = typed.trim();
    // Nothing typed yet (or back to the applied search): leave the page alone.
    // Resetting here would undo a Next click made before the first tick.
    if (next === q) return;
    const t = setTimeout(() => setQ(next), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [typed, q]);
  const list = useQuery(
    installsQuery({
      cursor: paging.cursor,
      state,
      q: q || undefined,
    }),
  );
  const jobs = useMemo(
    () =>
      new Map((world.data?.jobs.recent ?? []).map((j) => [j.id, j] as const)),
    [world.data],
  );
  const alerted = useMemo(
    () => new Set((world.data?.attention ?? []).map((a) => a.installId)),
    [world.data],
  );
  const rows = useMemo(() => {
    const items = (list.data?.items ?? []).filter(
      (i) => filter !== ATTENTION || alerted.has(i.id),
    );
    if (!sort) return items;
    return items.sort((a, b) => {
      const av = a[sort.key] ?? "";
      const bv = b[sort.key] ?? "";
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
  }, [list.data, sort, filter, alerted]);
  const filtering = !!filter || !!q || paging.canPrev;
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
          <Tiles world={world.data} filter={filter} onPick={setFilter} />
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
            <Input
              type="search"
              aria-label="Search slug, id, host or email"
              placeholder="Search slug, id, host or email"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </span>
          <Select
            value={filter ?? ALL}
            onValueChange={(v) => setFilter(parseStateFilter(v))}
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
              <SelectItem value={ATTENTION}>Needs attention</SelectItem>
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
      ) : list.data && rows.length === 0 ? (
        // Needs attention filters the loaded page: the next page may have some.
        <>
          <div className="oa-card oa-empty">
            <p>No installs on this page need attention.</p>
          </div>
          <Pager
            canPrev={paging.canPrev}
            next={list.data.nextCursor}
            onPrev={paging.prev}
            onNext={paging.next}
          />
        </>
      ) : list.data ? (
        <>
          {filter === ATTENTION && (
            <p className="oa-note">
              Showing the installs on this page that need attention.
            </p>
          )}
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
                      <TableCell className={i.version ? "oa-mono" : undefined}>
                        {i.version ?? <span className="oa-note">–</span>}
                      </TableCell>
                      <TableCell>
                        {i.tier ? (
                          TIER_LABEL[i.tier]
                        ) : (
                          <span className="oa-note">–</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {i.auth.providers.map(providerLabel).join(" · ")}
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
                              {alertLabel(a.kind)}
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
