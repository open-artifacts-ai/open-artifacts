import {
  type InstallState,
  InstallStateSchema,
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
import { useState } from "react";
import { installsQuery, worldQuery } from "../api/queries";
import { Pager, StateBadge } from "../components/Bits";
import { fmtTime } from "../components/format";
import { usePaging } from "../hooks/usePaging";
import { LoadError } from "../layout/LoadError";

function Strip({ world }: { world: World }) {
  const open = world.attention.filter((a) => a.open).length;
  const tok = world.provisioningToken;
  return (
    <section className="oa-strip" aria-label="Overview">
      <div data-testid="tile-installs">
        <strong>{world.installs.total}</strong> installs
        <small>
          {Object.entries(world.installs.byState)
            .filter(([, n]) => n > 0)
            .map(([s, n]) => `${n} ${s}`)
            .join(", ") || "none yet"}
        </small>
      </div>
      <div data-testid="tile-jobs">
        <strong>{world.jobs.active}</strong> active jobs
        <small>{world.jobs.failed24h} failed in 24 h</small>
      </div>
      <div data-testid="tile-attention">
        <strong>{world.attention.length}</strong> need attention
        <small>{open} alerting</small>
      </div>
      <div data-testid="tile-token">
        Provisioning token <strong>{tok.status}</strong>
        <small>
          {tok.daysLeft === null ? "no end date" : `${tok.daysLeft} days left`}
        </small>
      </div>
      <div data-testid="tile-scheduler">
        Scheduler <strong>{world.scheduler.stale ? "stale" : "running"}</strong>
        <small>last tick {fmtTime(world.scheduler.tickAt)}</small>
      </div>
      <div data-testid="tile-prodclean">
        Production check{" "}
        <strong>
          {world.prodClean ? (world.prodClean.ok ? "clean" : "dirty") : "none"}
        </strong>
        <small>
          {world.prodClean ? fmtTime(world.prodClean.at) : "never run"}
        </small>
      </div>
    </section>
  );
}

function Attention({ world }: { world: World }) {
  if (world.attention.length === 0) return null;
  return (
    <section aria-label="Needs attention">
      <h2>Needs attention</h2>
      <ul className="oa-attention">
        {world.attention.map((a) => (
          <li key={`${a.kind}:${a.installId}:${a.since}`}>
            {a.installId ? (
              <Link to="/installs/$id" params={{ id: a.installId }}>
                {a.slug ?? a.installId}
              </Link>
            ) : (
              "Platform"
            )}
            : {a.kind.replaceAll("_", " ")}
            {a.code && ` (${a.code})`}
            {a.message && ` ${a.message}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Installs() {
  const world = useQuery(worldQuery());
  const [state, setState] = useState<InstallState | "">("");
  const paging = usePaging();
  const list = useQuery(
    installsQuery({ cursor: paging.cursor, state: state || undefined }),
  );
  return (
    <>
      <div className="oa-head">
        <h1>Installs</h1>
        <Link to="/installs/new" className="oa-cta">
          Create install
        </Link>
      </div>
      {world.data && (
        <>
          <Strip world={world.data} />
          {world.data.truncated && (
            <p className="oa-note">The overview shows the newest 50 items.</p>
          )}
          <Attention world={world.data} />
        </>
      )}
      {world.isError && (
        <LoadError
          title="Couldn't load the overview"
          error={world.error}
          onRetry={() => void world.refetch()}
        />
      )}
      <label className="oa-filter">
        State{" "}
        <select
          value={state}
          onChange={(e) => {
            setState(e.target.value as InstallState | "");
            paging.reset();
          }}
        >
          <option value="">All</option>
          {InstallStateSchema.options.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {list.isError ? (
        <LoadError
          title="Couldn't load installs"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : list.data && list.data.items.length === 0 ? (
        <p className="oa-placeholder">
          {state || paging.canPrev ? "No installs match." : "No installs yet."}
        </p>
      ) : list.data ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <Link to="/installs/$id" params={{ id: i.id }}>
                      {i.slug}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StateBadge state={i.state} />
                  </TableCell>
                  <TableCell>{i.version ?? "none"}</TableCell>
                  <TableCell>{fmtTime(i.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
