// Provisioning API staging spikes S1, S2, S3, S5, S7 (design v7 13.1, 14.4),
// run by .github/workflows/provapi-staging-spikes.yml. Two throwaway Workers
// share this file:
// - oa-s-spike-<run>-wf (wrangler.workflow.jsonc) hosts the Workflow class;
// - oa-s-spike-<run> (wrangler.jsonc) binds it cross-script, plus the
//   staging dispatch namespace and a throwaway D1 database.
// Neither has a route, workers.dev or preview URL. The caller runs once, on
// its first cron tick (every minute, the shortest cron): every tick writes a
// "started" row, the first then writes each spike's result (a throw is an
// {ok: false, error} row) to its own D1 database, then a done row; every
// later tick returns at that row;
// CI reads them back over the D1 REST API. Reads only against rl-a and rl-b:
// every fetch below is a plain GET with no body.
import { WorkflowEntrypoint } from "cloudflare:workers";

interface Fetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
interface D1Result {
  meta: { changes: number };
  results: Record<string, unknown>[];
}
interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  run(): Promise<D1Result>;
  first(): Promise<Record<string, unknown> | null>;
}
interface D1 {
  prepare(sql: string): D1Stmt;
  batch(s: D1Stmt[]): Promise<D1Result[]>;
}
interface WfInstance {
  id: string;
  status(): Promise<{ status: string; error?: unknown }>;
}
interface Wf {
  create(o: { id: string; params?: unknown }): Promise<WfInstance>;
  get(id: string): Promise<WfInstance>;
}
export interface Env {
  ROLE: string;
  RUN_ID: string;
  SPIKES: string;
  RLB_SCRIPT: string;
  RLA_HEALTHZ: string;
  DB: D1;
  DISPATCHER: { get(name: string): Fetcher };
  WF: Wf;
}

export interface Result {
  spike: string;
  pass: boolean;
  observed: string;
  detail?: Record<string, unknown>;
}

/** The Workflow S3 creates; it only returns. */
export class SpikeWorkflow extends WorkflowEntrypoint {
  async run(): Promise<string> {
    return "ok";
  }
}

const errOf = (e: unknown) => ({
  name: e instanceof Error ? e.name : typeof e,
  message: e instanceof Error ? e.message : String(e),
});

export async function s1(): Promise<Result> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const msg = new TextEncoder().encode("oa-s-spike s1");
  const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, msg);
  const ok = await crypto.subtle.verify("Ed25519", kp.publicKey, sig, msg);
  const bad = await crypto.subtle.verify(
    "Ed25519",
    kp.publicKey,
    sig,
    new TextEncoder().encode("other"),
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const pass = ok && !bad && sig.byteLength === 64;
  return {
    spike: "s1",
    pass,
    observed: `verify=${ok} tampered=${bad} sig=${sig.byteLength}B pkcs8=${pkcs8.byteLength}B`,
  };
}

export async function s2(env: Env): Promise<Result> {
  const statuses: Record<string, number | string> = {};
  for (const p of ["/healthz", "/mcp"]) {
    try {
      // A plain GET: read-only against rl-b.
      const r = await env.DISPATCHER.get(env.RLB_SCRIPT).fetch(`https://x${p}`);
      statuses[p] = r.status;
      await r.body?.cancel();
    } catch (e) {
      statuses[p] = `threw ${errOf(e).name}: ${errOf(e).message}`;
    }
  }
  return {
    spike: "s2",
    pass: statuses["/healthz"] === 200 && typeof statuses["/mcp"] === "number",
    observed: `healthz=${statuses["/healthz"]} mcp=${statuses["/mcp"]}`,
    detail: statuses,
  };
}

export async function s3(env: Env): Promise<Result> {
  const id = `oa-s-spike-${env.RUN_ID}-a`;
  const d: Record<string, unknown> = { instance: id };
  let created = false;
  try {
    const inst = await env.WF.create({ id, params: {} });
    created = true;
    d.status = (await (await env.WF.get(inst.id)).status()).status;
  } catch (e) {
    d.create_error = errOf(e);
  }
  try {
    await env.WF.get("does-not-exist");
    d.get_missing = "no throw";
  } catch (e) {
    d.get_missing = errOf(e);
  }
  try {
    await env.WF.create({ id, params: {} });
    d.create_duplicate = "no throw";
  } catch (e) {
    d.create_duplicate = errOf(e);
  }
  const s = (v: unknown) =>
    typeof v === "string"
      ? v
      : `${(v as { name: string }).name}: ${(v as { message: string }).message}`;
  return {
    spike: "s3",
    pass: created && typeof d.status === "string",
    observed: `status=${String(d.status)}; get(missing) -> ${s(d.get_missing)}; duplicate create -> ${s(d.create_duplicate)}`,
    detail: d,
  };
}

export async function s5(env: Env): Promise<Result> {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS s5 (n INTEGER PRIMARY KEY)",
  ).run();
  let threw: unknown = null;
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO s5 (n) VALUES (1)"),
      env.DB.prepare("INSERT INTO s5_missing_table (n) VALUES (2)"),
    ]);
  } catch (e) {
    threw = errOf(e);
  }
  const row = await env.DB.prepare("SELECT count(*) AS c FROM s5").first();
  const c = Number(row?.c);
  return {
    spike: "s5",
    pass: threw !== null && c === 0,
    observed: `batch threw=${threw !== null}; rows after=${c}`,
    detail: { error: threw, rows: c },
  };
}

export async function s7(env: Env): Promise<Result> {
  try {
    // A plain GET: read-only against rl-a.
    const r = await fetch(env.RLA_HEALTHZ, { redirect: "manual" });
    await r.body?.cancel();
    return {
      spike: "s7",
      pass: r.status === 200,
      observed: `${env.RLA_HEALTHZ} -> ${r.status}`,
    };
  } catch (e) {
    return {
      spike: "s7",
      pass: false,
      observed: `${env.RLA_HEALTHZ} threw ${errOf(e).name}: ${errOf(e).message}`,
    };
  }
}

const SPIKES: Record<string, (env: Env) => Promise<Result>> = {
  s1,
  s2,
  s3,
  s5,
  s7,
};

/** The results table; deploy creates the same one (a test pins the text). */
const RESULTS_DDL =
  "CREATE TABLE IF NOT EXISTS results (spike TEXT PRIMARY KEY, json TEXT NOT NULL)";

const put = (env: Env, spike: string, row: unknown) =>
  env.DB.prepare("INSERT OR REPLACE INTO results (spike, json) VALUES (?, ?)")
    .bind(spike, JSON.stringify(row))
    .run();

/** "Name: message" of a throw, the shape every error row carries. */
const errText = (e: unknown) => `${errOf(e).name}: ${errOf(e).message}`;

/** Runs each requested spike once; a throw is that spike's failure only. */
export async function runOnce(env: Env, cron = ""): Promise<void> {
  // Every tick first marks that it fired, so CI can tell "the cron never
  // fired" from "it fired and a spike wrote no row".
  await env.DB.prepare(RESULTS_DDL).run();
  await put(env, "started", { at: new Date().toISOString(), cron });
  // After the first run, every later cron tick returns here (one read), so a
  // failed cleanup leaves a Worker that does nothing until it is deleted.
  try {
    if (await env.DB.prepare("SELECT 1 AS d FROM done LIMIT 1").first()) return;
  } catch {
    // No done table yet: the first run.
  }
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS claim (id INTEGER PRIMARY KEY)",
  ).run();
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO claim (id) VALUES (1)",
  ).run();
  if (claim.meta.changes !== 1) return;
  const wanted = env.SPIKES.split(",").filter((s) => s in SPIKES);
  for (const name of wanted) {
    let r: Result | (Result & { ok: false; error: string });
    try {
      r = await (SPIKES[name] as (env: Env) => Promise<Result>)(env);
    } catch (e) {
      r = {
        spike: name,
        ok: false,
        pass: false,
        error: errText(e),
        observed: `threw ${errText(e)}`,
      };
    }
    try {
      await put(env, name, r);
    } catch (e) {
      // The row itself would not write (too big, say): say so instead.
      await put(env, name, {
        spike: name,
        ok: false,
        pass: false,
        error: `result row not written: ${errText(e)}`,
        observed: `result row not written: ${errText(e)}`,
      });
    }
  }
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS done (id INTEGER PRIMARY KEY)",
  ).run();
  await env.DB.prepare("INSERT OR IGNORE INTO done (id) VALUES (1)").run();
}

export default {
  async scheduled(c: { cron?: string }, env: Env) {
    if (env.ROLE !== "caller") return;
    try {
      await runOnce(env, c?.cron ?? "");
    } catch (e) {
      // Outside any one spike (the claim, a table): CI names it.
      await put(env, "tick_error", { ok: false, error: errText(e) }).catch(
        () => {},
      );
      throw e;
    }
  },
};
