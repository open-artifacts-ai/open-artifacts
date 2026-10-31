import { TRANSITIONS } from "./authz.js";
import {
  type InstallState,
  JOB_STEPS,
  type TokenScopeSchema,
} from "./enums.js";
import { API_ERROR_STATUS, JOB_ERROR_RETRY } from "./errors.js";

// The MCP resource oa-admin://docs/lifecycle (design v7 9A.5), generated from
// the contract so it cannot drift. No data, so no authz beyond the bearer.

export const LIFECYCLE_DOC_URI = "oa-admin://docs/lifecycle";

/** API state precedence (5.1, the install_status view): first match wins. */
export const STATE_PRECEDENCE: readonly {
  state: InstallState;
  when: string;
  hosts: string;
}[] = [
  {
    state: "deleted",
    when: "installs.state is deleted, or the lifecycle row was discarded",
    hosts: "none (404)",
  },
  {
    state: "deleting",
    when: "installs.state is deleting, or deleted_at is set",
    hosts: "closed",
  },
  { state: "suspended", when: "suspended_at is set", hosts: "paused" },
  {
    state: "active",
    when: "installs.state is active or upgrading",
    hosts: "serving",
  },
  { state: "failed", when: "signups.status is failed", hosts: "none" },
  {
    state: "provisioning",
    when: "signups.status is pending, waiting_cap, queued or creating",
    hosts: "none until route",
  },
];

const SCOPES: Record<(typeof TokenScopeSchema.options)[number], string> = {
  "installs:read":
    "list and read installs, jobs, releases, slugs and the world",
  "installs:write": "create, upgrade, roll back, suspend, resume and retry",
  "installs:delete": "soft delete, restore, and purge failed creates",
  "installs:pii": "read owner emails",
  "audit:read": "read the audit log",
};

const table = (head: string[], rows: string[][]) =>
  [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

export function lifecycleDoc(): string {
  return [
    "# Open Artifacts install lifecycle",
    "",
    "Generated from @oa/shared/provisioning. It describes the rules, not any install.",
    "",
    "## States",
    "",
    "Each install has one state; the first condition that matches wins.",
    "",
    table(
      ["#", "State", "Condition", "HOSTS mode"],
      STATE_PRECEDENCE.map((s, i) => [String(i + 1), s.state, s.when, s.hosts]),
    ),
    "",
    "## Transitions",
    "",
    "A is an admin session, an agent token or OIDC within its scope; U is the self-serve owner; S is the scheduler. Anything not listed is 409 invalid_state.",
    "",
    table(
      ["From", "Job", "Actors", "To"],
      Object.entries(TRANSITIONS).flatMap(([from, row]) =>
        Object.entries(row).map(([kind, t]) => [
          from,
          kind,
          t?.actors.join(", ") ?? "",
          t?.to.join(", ") ?? "",
        ]),
      ),
    ),
    "",
    "## Job steps",
    "",
    table(
      ["Job", "Steps"],
      Object.entries(JOB_STEPS).map(([k, s]) => [k, s.join(" > ")]),
    ),
    "",
    "## Polling",
    "",
    "Every write returns a job. Poll it (GET /jobs/:id, get_job) every 2 s while it is queued or running, every 10 s after 2 minutes, and wait for retryAt when it is set.",
    "",
    "## API error codes",
    "",
    table(
      ["Code", "HTTP"],
      Object.entries(API_ERROR_STATUS).map(([c, s]) => [c, String(s)]),
    ),
    "",
    "## Job error codes",
    "",
    "These appear only in Job.error and Job.lastErrorCode.",
    "",
    table(
      ["Code", "Retry"],
      Object.entries(JOB_ERROR_RETRY).map(([c, r]) => [
        c,
        r === "terminal_alert" ? "terminal, alerts" : r,
      ]),
    ),
    "",
    "## Scopes",
    "",
    ...Object.entries(SCOPES).map(([s, d]) => `- \`${s}\`: ${d}`),
    "",
  ].join("\n");
}
