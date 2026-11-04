/**
 * The BusHub's whole database (#1291), ported from OpenBus 0.63.0. One DO per
 * member; every row still carries org_id, always OWNER_ORG_ID (bus/hub.ts),
 * kept as a constant for now (Product), so keys keep their OpenBus shape. Migrations add columns only: `create ... if not exists` is safe
 * to run on every wake, but it cannot change a key once deployed, so a key
 * change after the first deploy needs a new table.
 *
 * receipts is the durable spine of a message: one row per send, written before
 * any delivery attempt, so an eviction can never make a receipt lie. The body
 * lives in `mail` only when the hub had to store it (miss, oversized, or ack
 * timeout).
 *
 * agents.session_started_at (B11) is added the same way (migrateHub).
 *
 * B7 columns (added in place on an existing table by migrateHub):
 * notified_at is when the sender's machine was told the final state (null:
 * not yet told, replayed on its next agent_up); held_at is when the body was
 * last held in memory for an unacked inline push (null: not held), so a body
 * lost to an eviction is found with an index instead of a scan; final_at is
 * when the receipt left pending (retention of never-told receipts keys on it).
 *
 * machines mirrors the D1 bus_machines rows this hub accepted a socket for
 * (id, label, revoked_at): the token and its hash live only in D1. Open
 * Artifacts owns sign-in and the device flow, so OpenBus's device_codes,
 * oidc_states, linked_apps and card_rl tables are not here (roles came back
 * as role addresses, #1296). meta holds
 * the drain queues and the revocation time (BusHub.closeAll).
 */
export const HUB_SCHEMA = `
create table if not exists machines (
  id text primary key,
  org_id text not null,
  label text not null,
  created_at integer not null,
  revoked_at integer
);
create index if not exists machines_org on machines(org_id);
create index if not exists machines_list
  on machines(org_id, (revoked_at is null), created_at);

create table if not exists agents (
  id text primary key,
  org_id text not null,
  namespace text not null,
  name text not null,
  last_name text,
  kind text not null,
  machine_id text not null,
  native_ref text not null,
  global integer not null default 0,
  live integer not null default 0,
  updated_at integer not null,
  session_started_at integer not null default 0,
  session_start_rowid integer not null default 0,
  status text,
  status_label text,
  status_at integer,
  status_next text,
  status_due integer,
  unique(machine_id, native_ref)
);
create unique index if not exists agents_live_name
  on agents(org_id, namespace, name) where live = 1;
create unique index if not exists agents_global_name
  on agents(org_id, name) where live = 1 and global = 1;
create index if not exists agents_ns on agents(org_id, namespace, live);
create index if not exists agents_machine on agents(machine_id, live);
-- B5 fix 1: case-insensitive name checks (bus names are ASCII) and the
-- roster_changed fan-out (which machines host a live agent in a namespace).
create index if not exists agents_live_lname
  on agents(org_id, lower(name)) where live = 1;
create index if not exists agents_live_ns_machine
  on agents(org_id, namespace, machine_id) where live = 1;
create index if not exists agents_live_global_machine
  on agents(org_id, machine_id) where live = 1 and global = 1;
-- B6: send resolution also looks up closed agents by name (refused: closed).
create index if not exists agents_lname on agents(org_id, lower(name), live);
-- B9: the newest closed agent with a name decides revoked vs closed.
create index if not exists agents_lname_recent
  on agents(org_id, lower(name), live, updated_at);
-- B10: the dashboard's agent list, ordered by namespace then lower(name).
create index if not exists agents_live_ns_lname
  on agents(org_id, namespace, lower(name)) where live = 1;

create table if not exists receipts (
  id text primary key,
  org_id text not null,
  namespace text not null,
  to_agent text,
  to_name text not null,
  from_agent text not null,
  from_name text not null,
  state text not null,
  reason text,
  size integer not null,
  created_at integer not null,
  expires_at integer not null,
  acked_at integer,
  notified_at integer,
  held_at integer,
  final_at integer
);
create index if not exists receipts_to on receipts(to_agent, state);
create index if not exists receipts_due on receipts(state, expires_at);

create table if not exists mail (
  id text primary key,
  org_id text not null,
  to_agent text,
  body text not null,
  created_at integer not null,
  expires_at integer not null
);
create index if not exists mail_due on mail(expires_at);


-- B14: idempotent send. One row per (sender agent, send frame id) for
-- SEND_KEY_RETAIN_MS: the payload hash and the msg_id of the send's receipt.
-- Only a send that created a pending receipt has a key (a refused send
-- delivered nothing; its resend is evaluated again). A table of its own, not
-- columns on receipts: the per-agent cap must evict keys without touching
-- receipts, a key needs no column on the receipts hot path, and the
-- key's lifetime is independent of receipt retention. The primary key is the
-- dedupe key (agent ids are unique across orgs). send_keys_agent counts an
-- agent's keys for the per-agent cap; send_keys_due drives the alarm sweep.
-- final (added by migrateHub, with its partial indexes) is 1 once the key's
-- receipt has left pending; the caps evict only final keys.
create table if not exists send_keys (
  from_agent text not null,
  frame_id text not null,
  org_id text not null,
  payload_hash text not null,
  msg_id text not null,
  created_at integer not null,
  primary key (from_agent, frame_id)
);
create index if not exists send_keys_agent on send_keys(from_agent);
create index if not exists send_keys_due on send_keys(created_at);

-- R393b (#1325, OpenBus #393): names an agent left by a rename, which still
-- reach it until expires_at (LIMITS.formerNameGraceMs). kind is the left
-- name's kind: 'chosen' rows are reserved (nameTaken, putRole), 'default'
-- rows only resolve (their minted_names row keeps the name from anyone
-- else). OpenBus #451: 'held' rows are names an agent left a scope under (a
-- close, revoke, offline reap, namespace move or global flip): reserved
-- there, never resolving, never on the roster. A close keeps the chosen rows
-- (reserved, resolving to no one until a reopen in their scope) and drops
-- the default ones; expired rows are purged by the alarm. Never equal
-- (case-insensitively) to the agent's current name in its scope, distinct
-- per agent and scope (lname), at most LIMITS.maxFormerNames non-held rows
-- per agent (OpenBus #446: an older default one is dropped). Held rows are
-- never dropped early; every scope change counts in rename_rl, which bounds
-- them. OpenBus #451: namespace and global are the scope the name was
-- left in (added by migrateHub on an older hub). A row resolves only while
-- its agent is still in that scope; after a namespace move or global flip a
-- chosen row stays, reserving the name there for its grace (roles included)
-- and resolving to no one. New tables, so create-if-not-exists adds them to
-- an existing hub on its next wake; wipe() deletes them with everything else.
create table if not exists former_names (
  agent_id text not null,
  org_id text not null,
  name text not null,
  lname text not null,
  kind text not null,
  expires_at integer not null,
  namespace text not null default '',
  global integer not null default 0
);
create index if not exists former_names_lname on former_names(org_id, lname, expires_at);
create index if not exists former_names_agent on former_names(agent_id, expires_at);
create index if not exists former_names_due on former_names(expires_at);

-- R393b: every name minted for a default name_kind (<base>-<4 hex>). Kept
-- for good: a minted name is never minted again, and never assigned to any
-- other agent (nameTaken, OpenBus #446; the primary key serves its lookup);
-- its own agent gets it back.
create table if not exists minted_names (
  org_id text not null,
  lname text not null,
  name text not null,
  agent_id text not null,
  lbase text not null,
  created_at integer not null,
  primary key (org_id, lname)
);
create index if not exists minted_names_agent on minted_names(agent_id, lbase, created_at);

-- R393b: the rename rate limit, a sliding log: one row per name change
-- (no-ops excluded; a live agent_up's included), LIMITS.renamesPerHour per
-- agent per rolling hour. Kept through a close (OpenBus #446), dropped on a
-- revoke, purged by the alarm.
create table if not exists rename_rl (
  agent_id text not null,
  at integer not null
);
create index if not exists rename_rl_agent on rename_rl(agent_id, at);
create index if not exists rename_rl_at on rename_rl(at);

-- #1296 role addresses: a member-set alias (name, lname = lower(name)) in one
-- namespace pointing at one agent by id (agent_id, null: vacated), so it
-- follows a rename. A close leaves agent_id: the role reads vacant while its
-- holder isn't open in the namespace (bus/roles.ts). Role names share the
-- agent-name space of their namespace (nameTaken, putRole). A new table, so
-- create-if-not-exists adds it on the next wake; wipe() deletes it.
create table if not exists roles (
  id text primary key,
  org_id text not null,
  namespace text not null,
  name text not null,
  lname text not null,
  agent_id text,
  set_at integer not null,
  unique (org_id, namespace, lname)
);
create index if not exists roles_lname on roles(org_id, lname);

-- #1372 role proposals: a role change an AI agent proposed over MCP
-- (bus_role_propose). Nothing changes until the member confirms it in a
-- browser on its link; token_hash is the sha256 of that link's secret (the
-- secret is never stored). action: set | repoint | clear; role_id: the role
-- it re-points or clears (null for set); agent_id: the new holder (null for
-- clear); prior_agent_id: the holder it displaces, as of the proposal;
-- agent_name, prior_holder_name: their names then (what the member is
-- shown; a rename since refuses the confirm as changed). The
-- confirm applies only while the role is still as it was (bus/roles.ts
-- confirmProposal). status: pending | applied | refused | expired, decided
-- once. A new table: create-if-not-exists adds it; wipe() deletes it.
create table if not exists role_proposals (
  id text primary key,
  org_id text not null,
  token_hash text not null unique,
  action text not null,
  namespace text not null,
  name text not null,
  lname text not null,
  role_id text,
  agent_id text,
  agent_name text,
  prior_agent_id text,
  prior_holder_name text,
  created_at integer not null,
  expires_at integer not null,
  status text not null default 'pending',
  reason text,
  decided_at integer
);
create index if not exists role_proposals_created on role_proposals(org_id, created_at);
create index if not exists role_proposals_pending on role_proposals(expires_at)
  where status = 'pending';

create table if not exists meta (
  org_id text not null,
  key text not null,
  value text not null,
  primary key (org_id, key)
);
`;

const HUB_SCHEMA_B7_INDEXES = `
-- Flush: a recipient's pending mail, oldest first.
create index if not exists receipts_to_age on receipts(to_agent, state, created_at);
-- Lost bodies: pending receipts whose body was held in memory.
create index if not exists receipts_held on receipts(held_at)
  where state = 'pending' and held_at is not null;
-- Replay: a sender's final receipts it was never told about, oldest first.
create index if not exists receipts_unnotified on receipts(from_agent, created_at)
  where notified_at is null and state != 'pending';
-- Retention of final receipts.
create index if not exists receipts_unnotified_final on receipts(final_at)
  where notified_at is null and state != 'pending';
create index if not exists receipts_notified on receipts(notified_at)
  where notified_at is not null;
`;

/**
 * Add-only migrations for tables created before the column existed, then the
 * indexes on those columns. Idempotent: run on every wake after HUB_SCHEMA.
 * Each statement is a fixed literal, or (AC3) built from a fixed literal list.
 *
 * The backfills run once, only in the step that adds the column:
 * - notified_at (absent on a B6 hub): B6 told senders live and recorded
 *   nothing, so already final rows count as told (no duplicate replay). B6
 *   also left a closed agent's spilled mail pending; it expires now as
 *   recipient_closed with its body dropped (spec: not kept for a reopened
 *   session) and reaches the sender by replay on its next agent_up.
 * - final_at: final rows get coalesce(acked_at, expires_at).
 */
export function migrateHub(sql: SqlStorage, now: number = Date.now()): void {
  // B11: when the agent's current session began (agent_up of a closed or new
  // agent); fetch, flush and ack serve only that session's mail. Backfilled
  // as 0 (the column default): every existing row keeps today's behavior
  // until its next new session.
  const agentCols = new Set(
    sql
      .exec<{ name: string }>("select name from pragma_table_info('agents')")
      .toArray()
      .map((r) => r.name),
  );
  if (!agentCols.has("session_started_at"))
    sql.exec(
      "alter table agents add column session_started_at integer not null default 0",
    );
  // B11 L1: the session boundary as a receipts rowid (max(rowid) at the
  // agent_up that started the session); fetch, flush, ack and the inbox cap
  // take rowid > it. Backfill 0: existing sessions see all their mail.
  // session_started_at (ms) is superseded by it and no longer read.
  if (!agentCols.has("session_start_rowid"))
    sql.exec(
      "alter table agents add column session_start_rowid integer not null default 0",
    );
  // AC3: self-reported status (hub/status.ts): applied, then a coalesced
  // pending update and when it is due. Null on a closed agent.
  for (const [col, type] of [
    ["status", "text"],
    ["status_label", "text"],
    ["status_at", "integer"],
    ["status_next", "text"],
    ["status_due", "integer"],
  ] as const)
    if (!agentCols.has(col))
      sql.exec(`alter table agents add column ${col} ${type}`);
  sql.exec(
    "create index if not exists agents_status_due on agents(status_due) where status_due is not null",
  );
  // B11 H1: the recipient on every stored body, so close and revoke cleanup
  // walk only rows that hold a body (mail_to), never the delivered history.
  const mailCols = new Set(
    sql
      .exec<{ name: string }>("select name from pragma_table_info('mail')")
      .toArray()
      .map((r) => r.name),
  );
  if (!mailCols.has("to_agent")) {
    sql.exec("alter table mail add column to_agent text");
    sql.exec(
      "update mail set to_agent = (select r.to_agent from receipts r where r.id = mail.id)",
    );
  }
  sql.exec("create index if not exists mail_to on mail(to_agent)");
  const cols = new Set(
    sql
      .exec<{ name: string }>("select name from pragma_table_info('receipts')")
      .toArray()
      .map((r) => r.name),
  );
  const fromB6 = !cols.has("notified_at");
  if (fromB6) {
    sql.exec("alter table receipts add column notified_at integer");
    sql.exec(
      "update receipts set notified_at = coalesce(acked_at, created_at) where state != 'pending'",
    );
  }
  if (!cols.has("held_at"))
    sql.exec("alter table receipts add column held_at integer");
  if (!cols.has("final_at")) {
    sql.exec("alter table receipts add column final_at integer");
    sql.exec(
      "update receipts set final_at = coalesce(acked_at, expires_at) where state != 'pending'",
    );
  }
  if (fromB6) {
    sql.exec(
      `delete from mail where id in (select r.id from receipts r join agents a on a.id = r.to_agent
         where r.state = 'pending' and a.live = 0)`,
    );
    sql.exec(
      `update receipts set state = 'expired', reason = 'recipient_closed', final_at = ?
         where state = 'pending' and to_agent in (select id from agents where live = 0)`,
      now,
    );
  }
  sql.exec(HUB_SCHEMA_B7_INDEXES);
  // open-bus #422: when the machine's last daemon socket went (epoch ms);
  // null while it is connected, or not yet seen offline. The alarm closes the
  // live agents of a machine offline past OFFLINE_REAP_MS. No backfill here:
  // a machine already offline starts counting at the hub's next wake.
  const machineCols = new Set(
    sql
      .exec<{ name: string }>("select name from pragma_table_info('machines')")
      .toArray()
      .map((r) => r.name),
  );
  if (!machineCols.has("disconnected_at"))
    sql.exec("alter table machines add column disconnected_at integer");
  // B14: send_keys.final (1 once the key's receipt left pending), set
  // wherever a receipt is finalized (settle, #expire). Backfilled from
  // receipts in the step that adds it (a missing receipt counts as final).
  const keyCols = new Set(
    sql
      .exec<{ name: string }>("select name from pragma_table_info('send_keys')")
      .toArray()
      .map((r) => r.name),
  );
  if (!keyCols.has("final")) {
    sql.exec(
      "alter table send_keys add column final integer not null default 0",
    );
    sql.exec(
      `update send_keys set final = 1 where not exists
         (select 1 from receipts r where r.id = send_keys.msg_id and r.state = 'pending')`,
    );
  }
  // #1296: send_keys.via_role is 1 when the send resolved through a role
  // address, so a resend repeats the role hit's to_name only to a socket
  // with BUS_CAPS.roles. Backfilled 0: no key predates roles.
  if (!keyCols.has("via_role"))
    sql.exec(
      "alter table send_keys add column via_role integer not null default 0",
    );
  sql.exec(HUB_SCHEMA_B14_INDEXES);
  sql.exec(HUB_SCHEMA_PURGE_INDEXES);
  // OpenBus #451: the scope a former name was left in. Backfilled from its
  // agent: before #451 a move or close dropped the rows, so every row is in
  // its agent's current scope.
  const formerCols = new Set(
    sql
      .exec<{ name: string }>(
        "select name from pragma_table_info('former_names')",
      )
      .toArray()
      .map((r) => r.name),
  );
  if (!formerCols.has("namespace") || !formerCols.has("global")) {
    if (!formerCols.has("namespace"))
      sql.exec(
        "alter table former_names add column namespace text not null default ''",
      );
    if (!formerCols.has("global"))
      sql.exec(
        "alter table former_names add column global integer not null default 0",
      );
    sql.exec(
      `update former_names set
         namespace = coalesce((select a.namespace from agents a where a.id = former_names.agent_id), ''),
         global = coalesce((select a.global from agents a where a.id = former_names.agent_id), 0)`,
    );
  }
}

/**
 * Final review M1: closed agents are purged once idle. agents_closed drives
 * the alarm's purge (oldest closed first, hub-wide); agents_machine_closed
 * the per-machine cap's inline purge (that machine's oldest closed first).
 * receipts_from_pending answers "does this agent still have a send in
 * flight" without walking its sent history.
 */
const HUB_SCHEMA_PURGE_INDEXES = `
create index if not exists agents_closed on agents(updated_at) where live = 0;
create index if not exists agents_machine_closed
  on agents(machine_id, updated_at) where live = 0;
create index if not exists receipts_from_pending on receipts(from_agent)
  where state = 'pending';
`;

const HUB_SCHEMA_B14_INDEXES = `
-- Finalizing a receipt marks its key.
create index if not exists send_keys_msg on send_keys(msg_id);
-- The caps' eviction: the oldest final key, hub-wide and per agent.
create index if not exists send_keys_final on send_keys(created_at) where final = 1;
create index if not exists send_keys_agent_final
  on send_keys(from_agent, created_at) where final = 1;
`;
