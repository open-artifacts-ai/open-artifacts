// The alert conditions (design v7 5.8): C2's exported queries on platform
// D1, never a copy, plus token_expiring and token_invalid from
// PROVISIONER.tokenStatus(). Rows mean open, no rows clear, and a failed
// read is null (left as it is).
import type { ProvisionerRpc } from "@oa/shared/provisioning";
import {
  ALERT_CONDITIONS,
  type AlertRow,
  alertParams,
  type RPC_ALERT_KEYS,
  SQL_ALERT_KEYS,
  type SqlAlertKey,
} from "@oa/shared/provisioning/alerts";
import type { AlertKey } from "@oa/shared/provisioning/enum-values";
import { TokenStatusSchema } from "./contract.js";
import { within } from "./env.js";

type RpcAlertKey = (typeof RPC_ALERT_KEYS)[number];

export interface Condition {
  /** true: open; false: clear; null: unknown, leave as it is. */
  open: boolean | null;
  rows: AlertRow[];
  /** token_expiring only. */
  daysLeft?: number;
}

/** A tokenStatus() call that hasn't settled by then is unknown. */
export const TOKEN_STATUS_TIMEOUT_MS = 5_000;

/** SIGNUP_DAILY_CAP as the query binds it; unset or malformed is 0 (off). */
export function signupDailyCap(v: string | undefined): number {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export async function sqlConditions(
  db: D1Database,
  input: { now: number; signupDailyCap: number },
): Promise<Record<SqlAlertKey, Condition>> {
  const out = {} as Record<SqlAlertKey, Condition>;
  for (const k of SQL_ALERT_KEYS) {
    try {
      const { results } = await db
        .prepare(ALERT_CONDITIONS[k].sql)
        .bind(...alertParams(k, input))
        .all<AlertRow>();
      out[k] = { open: results.length > 0, rows: results };
    } catch {
      console.error("provapi alert", k, "query_error");
      out[k] = { open: null, rows: [] };
    }
  }
  return out;
}

export async function tokenConditions(
  rpc: ProvisionerRpc | undefined,
  timeoutMs = TOKEN_STATUS_TIMEOUT_MS,
): Promise<Record<RpcAlertKey, Condition>> {
  const unknown = {
    token_expiring: { open: null, rows: [] },
    token_invalid: { open: null, rows: [] },
  };
  if (!rpc) {
    console.error("provapi alert token_status unbound");
    return unknown;
  }
  let raw: unknown;
  try {
    raw = await within(
      Promise.resolve().then(() => rpc.tokenStatus()),
      timeoutMs,
    );
  } catch {
    console.error("provapi alert token_status rpc_error");
    return unknown;
  }
  const s = TokenStatusSchema.safeParse(raw);
  if (!s.success) {
    console.error("provapi alert token_status parse_error");
    return unknown;
  }
  const { status, daysLeft } = s.data;
  return {
    // Invalid says nothing about the end date: left as it is, so an
    // expiring token that expires never mails "no longer near its end
    // date" while token_invalid opens. Only active or expiring decide it.
    token_expiring: {
      open: status === "invalid" ? null : status === "expiring",
      rows: [],
      ...(daysLeft === null
        ? {}
        : { daysLeft: Math.max(0, Math.floor(daysLeft)) }),
    },
    token_invalid: { open: status === "invalid", rows: [] },
  };
}

/** Every key's condition, for one tick. */
export async function alertConditions(
  db: D1Database,
  rpc: ProvisionerRpc | undefined,
  input: { now: number; signupDailyCap: number },
  o: { tokenTimeoutMs?: number } = {},
): Promise<Record<AlertKey, Condition>> {
  return {
    ...(await sqlConditions(db, input)),
    ...(await tokenConditions(rpc, o.tokenTimeoutMs)),
  };
}
