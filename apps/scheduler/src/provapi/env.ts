import type { Env as OaEnv } from "@oa/provision/names";
import type { ProvisionerRpc, WorkflowLike } from "@oa/shared/provisioning";

/**
 * The Provisioning API duties' bindings (design v7 5.8). Optional: an
 * unbound one fails only the duties that need it (`unbound`).
 */
export interface ProvapiEnv {
  PLATFORM_DB: D1Database;
  DISPATCHER: DispatchNamespace;
  OA_ENV: OaEnv;
  /** oa-<p>-provision-install (ProvisionInstall on oa-<p>-provisioner). */
  PROVISION_INSTALL?: WorkflowLike;
  /** oa-<p>-manage-install (ManageInstall on oa-<p>-provisioner). */
  MANAGE_INSTALL?: WorkflowLike;
  /** oa-<p>-provisioner's ProvisionerRpc entrypoint. */
  PROVISIONER?: ProvisionerRpc;
  /** Cloudflare Email Service; unbound means no destination. */
  ALERT_EMAIL?: SendEmail;
  /** The operator's address; empty or malformed means no destination. */
  ALERT_TO?: string;
  /** The sender, on a domain the account sends from. */
  ALERT_FROM?: string;
  /** The provisioner's self-serve daily cap; unset or 0 means no cap alert. */
  SIGNUP_DAILY_CAP?: string;
}

/** A duty failure with a fixed log category (never the error text). */
export class DutyFailure extends Error {
  override name = "DutyFailure";
  constructor(readonly category: DutyCategory) {
    super(category);
  }
}

export type DutyCategory =
  | "unbound"
  | "db_error"
  | "rpc_error"
  | "parse_error"
  | "timeout"
  | "exception";

export function bound<T>(v: T | undefined): T {
  if (v === undefined || v === null) throw new DutyFailure("unbound");
  return v;
}

/** Runs a D1 call; any failure is db_error. */
export async function d1<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch {
    throw new DutyFailure("db_error");
  }
}

export class Stall extends Error {}

/** Resolves with p, or rejects with Stall after ms; the timer is always cleared. */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Stall()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Runs `f` over `items`, at most `n` at a time. */
export async function lanes<T>(
  items: readonly T[],
  n: number,
  f: (t: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await f(items[next++] as T);
  };
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, lane),
  );
}
