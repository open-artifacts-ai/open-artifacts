// The provisioner probes (pending/provisioner.test.ts): a signup goes in the
// way SS4 sends one, a pending signups row and its signup_secret in platform
// D1, then { signupId } on oa-s-signups, and the probe reads what the
// provisioner made of it. Staging only; the config is REDLINE_STG_PROVISIONER.
// The token never reaches a report: errors name the call and its status only.

import { randomBytes } from "node:crypto";
import { readSecretFile } from "./targets.ts";

const API = "https://api.cloudflare.com/client/v4";

export interface ProvisionerProbe {
  accountId: string;
  /** Platform D1 (oa-s-platform). */
  platformDbId: string;
  /** The oa-s-signups queue id. */
  signupsQueueId: string;
  /** A 0600 file: D1 Edit on the platform DB and Queues Write on oa-s-signups. */
  tokenFile: string;
  /**
   * A standing signup the provisioner already made ready (made once, by the
   * enable step in docs/ops/hosted.md), replayed by every run.
   */
  replaySignupId: string;
}

const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** The probe config, or undefined when REDLINE_STG_PROVISIONER is unset; throws on a bad one. */
export function parseProvisionerProbe(
  env: Record<string, string | undefined> = process.env,
): ProvisionerProbe | undefined {
  const raw = env.REDLINE_STG_PROVISIONER;
  if (raw === undefined || raw === "") return undefined;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("REDLINE_STG_PROVISIONER is not JSON");
  }
  const field = (k: keyof ProvisionerProbe, re?: RegExp): string => {
    const s = v?.[k];
    if (typeof s !== "string" || s === "" || (re && !re.test(s)))
      throw new Error(`REDLINE_STG_PROVISIONER.${k} is missing or malformed`);
    return s;
  };
  return {
    accountId: field("accountId", HEX32),
    platformDbId: field("platformDbId", UUID),
    signupsQueueId: field("signupsQueueId", HEX32),
    tokenFile: field("tokenFile"),
    replaySignupId: field("replaySignupId", ULID_RE),
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID for `now` (48-bit time, 80 random bits), as SS4 mints one. */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(r[i] as number) % 32];
  return time + rand;
}

export type Row = Record<string, unknown>;

export interface ProvisionerClient {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  /** One { signupId } message on oa-s-signups, exactly SS4's shape. */
  enqueue(signupId: string): Promise<void>;
}

export function provisionerClient(
  p: ProvisionerProbe,
  f: typeof fetch = fetch,
): ProvisionerClient {
  const token = readSecretFile(p.tokenFile, "REDLINE_STG_PROVISIONER token");
  const acct = `${API}/accounts/${p.accountId}`;
  const post = async (what: string, url: string, body: unknown) => {
    const res = await f(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      success?: unknown;
      result?: unknown;
    } | null;
    if (!res.ok || json?.success !== true)
      throw new Error(`${what}: Cloudflare answered ${res.status}`);
    return json.result;
  };
  return {
    async query(sql, params = []) {
      const r = (await post(
        "platform D1 query",
        `${acct}/d1/database/${p.platformDbId}/query`,
        { sql, params },
      )) as { results?: Row[] }[] | undefined;
      return r?.[0]?.results ?? [];
    },
    async enqueue(signupId) {
      if (!ULID_RE.test(signupId)) throw new Error("enqueue: not a ULID");
      await post(
        "oa-s-signups send",
        `${acct}/queues/${p.signupsQueueId}/messages`,
        { body: { signupId } },
      );
    },
  };
}

/** The fields of a signup a replay must leave as they were. */
export const SIGNUP_FIELDS =
  "status, install_id, admitted_at, welcome_claimed_at, welcome_sent_at, error, updated_at";

/**
 * Writes a pending signup the way SS4 does: the row, then its secret, both
 * before the message. Two statements, one per call: the REST query takes
 * params for a single statement.
 */
export async function insertPending(
  c: ProvisionerClient,
  s: { signupId: string; slug: string; ownerSub: string; ownerEmail: string },
  now = Date.now(),
): Promise<void> {
  await c.query(
    "INSERT INTO signups (signup_id, owner_sub, slug, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?4)",
    [s.signupId, s.ownerSub, s.slug, now],
  );
  await c.query(
    "INSERT INTO signup_secret (signup_id, owner_email) VALUES (?1, ?2)",
    [s.signupId, s.ownerEmail],
  );
}

/** Removes a probe's own signup (row and secret). Never a fixture's. */
export async function removeSignup(
  c: ProvisionerClient,
  signupId: string,
): Promise<void> {
  await c.query("DELETE FROM signup_secret WHERE signup_id = ?1", [signupId]);
  await c.query("DELETE FROM signups WHERE signup_id = ?1", [signupId]);
}

/**
 * Polls `read` every `everyMs` until `done` holds or `ms` runs out; the last
 * value either way. The bound is the caller's, from the provisioner's own
 * limits (its retries and backoff), never a guess at "long enough".
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms: number,
  everyMs = 5_000,
  sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n)),
  now = Date.now,
): Promise<{ value: T; met: boolean }> {
  const end = now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return { value, met: true };
    if (now() >= end) return { value, met: false };
    await sleep(everyMs);
  }
}
