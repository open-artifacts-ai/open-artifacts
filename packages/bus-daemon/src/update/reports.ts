import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Update reports waiting to be sent (#2552). PR 4 only queues them in
 * `<home>/update-reports.json` (0600); the wire that sends and removes them
 * comes later, so a step-back report survives a restart.
 */
export type ReportEvent =
  | "updated"
  | "stepped_back"
  | "refused"
  | "needs_you"
  | "ready_24h";

export type Report = {
  event: ReportEvent;
  from: string;
  to: string;
  /** A closed, short token: never text from the wire. */
  reason: string;
  /** ms epoch */
  at: number;
};

export const MAX_REPORTS = 50;
export const reportFile = (home: string) => join(home, "update-reports.json");

const EVENTS = new Set<string>([
  "updated",
  "stepped_back",
  "refused",
  "needs_you",
  "ready_24h",
]);
const REASON = /^[a-z0-9_]{1,40}$/;

export function readReports(home: string): Report[] {
  try {
    const j: unknown = JSON.parse(readFileSync(reportFile(home), "utf8"));
    if (!Array.isArray(j)) return [];
    return j.filter(
      (r): r is Report =>
        r !== null &&
        typeof r === "object" &&
        EVENTS.has(r.event) &&
        typeof r.from === "string" &&
        typeof r.to === "string" &&
        REASON.test(r.reason) &&
        typeof r.at === "number",
    );
  } catch {
    return [];
  }
}

/** Appends one report (oldest dropped past MAX_REPORTS). Never throws. */
export function queueReport(home: string, r: Report): void {
  if (!EVENTS.has(r.event) || !REASON.test(r.reason)) return;
  const tmp = `${reportFile(home)}.${process.pid}.tmp`;
  try {
    const list = [...readReports(home), r].slice(-MAX_REPORTS);
    writeFileSync(tmp, `${JSON.stringify(list)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, reportFile(home));
  } catch {
    rmSync(tmp, { force: true });
  }
}

/** Removes reports already sent (the first equal entry each); the rest stay queued. */
export function removeReports(home: string, sent: Report[]): void {
  if (sent.length === 0) return;
  const tmp = `${reportFile(home)}.${process.pid}.tmp`;
  try {
    const left = [...readReports(home)];
    for (const r of sent) {
      const i = left.findIndex(
        (x) =>
          x.event === r.event &&
          x.from === r.from &&
          x.to === r.to &&
          x.reason === r.reason &&
          x.at === r.at,
      );
      if (i >= 0) left.splice(i, 1);
    }
    writeFileSync(tmp, `${JSON.stringify(left)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, reportFile(home));
  } catch {
    rmSync(tmp, { force: true });
  }
}

/** The rescue shim's version, from its own first line; 0 when there is none. */
export function readRescueVersion(home: string): number {
  try {
    const head = readFileSync(join(home, "rescue.mjs"), "utf8").slice(0, 200);
    const n = /Rescue shim (\d{1,6})\./.exec(head)?.[1];
    return n === undefined ? 0 : Number(n);
  } catch {
    return 0;
  }
}
