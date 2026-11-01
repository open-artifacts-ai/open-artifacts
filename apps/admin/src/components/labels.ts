// Design's W11 copy: state, health and job step labels, and time formats.
import type {
  Health,
  InstallState,
  Job,
  JobKind,
  JobStatus,
} from "@oa/shared/provisioning";

export const STATE_LABEL: Record<InstallState, string> = {
  provisioning: "Creating",
  active: "Active",
  suspended: "Paused",
  deleting: "Deleted, restorable",
  deleted: "Deleted",
  failed: "Create failed",
};
export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
};
export const HEALTH_LABEL: Record<Health, string> = {
  ok: "OK",
  failing: "Failing",
  unknown: "Unknown",
};

/**
 * Job step ids (JOB_STEPS) to Design's labels. `null`: an internal step the
 * panel does not show ("active" folds into "Turn on sign-in"; "done" ends it).
 */
const STEP_LABEL: Record<string, string | null> = {
  admit: "Queue the job",
  recheck: "Check the request",
  reserve: "Reserve slug and hosts",
  release_gate: "Check the release",
  upload: "Upload",
  verify_clean: "Verify clean",
  health: "Health check",
  route: "Route hosts",
  enable_signin: "Turn on sign-in",
  active: null,
  reachable: "Check it answers",
  notify: "Notify",
  done: null,
  // Steps Design's page does not list (other job kinds).
  pause: "Pause serving",
  record: "Record the change",
  unpause: "Resume serving",
  close: "Close the hosts",
  reopen: "Reopen the hosts",
  unroute: "Unroute the hosts",
  revoke_directory: "Revoke directory access",
  teardown: "Remove the install",
  free: "Free the slug",
  release: "Release the lease",
  release_lease: "Release the lease",
  sweep_tokens: "Sweep tokens",
  settle: "Settle",
  rotate_hook_key: "Rotate the hook key",
  mint: "Mint credentials",
  seal: "Seal the credentials",
};
export const stepLabel = (id: string): string | null =>
  Object.hasOwn(STEP_LABEL, id) ? STEP_LABEL[id] : id.replaceAll("_", " ");

/** The steps to show, in order, with their index in Job.steps. */
export const visibleSteps = (steps: readonly string[]) =>
  steps
    .map((id, index) => ({ id, index, label: stepLabel(id) }))
    .filter(
      (s): s is { id: string; index: number; label: string } => !!s.label,
    );

/** "step 6 of 11": 1-based position of the job's step among the shown steps. */
export function stepCount(job: Pick<Job, "steps" | "stepIndex" | "status">) {
  const shown = visibleSteps(job.steps);
  const done = job.status === "done";
  const at = shown.filter((s) => s.index <= job.stepIndex).length;
  return { n: done ? shown.length : Math.max(at, 1), of: shown.length };
}

export const JOB_VERB: Record<JobKind, { ing: string; noun: string }> = {
  create: { ing: "Creating", noun: "Create" },
  retry: { ing: "Retrying the create of", noun: "Retry" },
  upgrade: { ing: "Upgrading", noun: "Upgrade" },
  rollback: { ing: "Rolling back", noun: "Rollback" },
  suspend: { ing: "Pausing", noun: "Pause" },
  resume: { ing: "Resuming", noun: "Resume" },
  delete: { ing: "Deleting", noun: "Delete" },
  restore: { ing: "Restoring", noun: "Restore" },
  purge: { ing: "Deleting for good", noun: "Purge" },
  discard: { ing: "Discarding", noun: "Discard" },
  release_lease: { ing: "Releasing the lease on", noun: "Release lease" },
  cleanup: { ing: "Cleaning up", noun: "Cleanup" },
  redline_creds: { ing: "Minting credentials for", noun: "Credentials" },
};

/** The version an upgrade-like job moves to: the API stores `version`, fixtures use `to`. */
export const jobTarget = (args: Record<string, unknown>): string | null => {
  const v = args.to ?? args.version;
  return typeof v === "string" ? v : null;
};

export const SERVING_LABEL = {
  serving: "Serving",
  paused: "Paused",
  closed: "Closed",
  unmapped: "Not routed",
} as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const p2 = (n: number) => String(n).padStart(2, "0");
/** "Oct 31" (UTC). */
export const fmtDay = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
/** "14:02" (UTC). */
export const fmtClock = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
};
/** "Oct 31 14:10" (UTC). */
export const fmtDayClock = (ms: number) => `${fmtDay(ms)} ${fmtClock(ms)}`;
/** "1 min", "45 s", "now". */
export const fmtIn = (ms: number) => {
  if (ms <= 0) return "now";
  if (ms < 59_500) return `${Math.ceil(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
};
/** "6 h", "40 min". */
export const fmtLeft = (ms: number) =>
  ms >= 3_600_000
    ? `${Math.floor(ms / 3_600_000)} h`
    : `${Math.max(1, Math.round(ms / 60_000))} min`;
/** "01JC7X…" */
export const shortId = (id: string) => `${id.slice(0, 6)}…`;

/** "just now", "2 min ago", else the UTC clock time today or the day. */
export const fmtAgo = (ms: number | null, now: number) => {
  if (ms === null) return "Never";
  const d = now - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  return d < 86_400_000 ? fmtClock(ms) : fmtDay(ms);
};
