import {
  bundleSha256,
  type Cf,
  CfError,
  cfClient,
  isInstallId,
  NAMESPACES,
  names,
  openReleaseRecord,
  platformNames,
  RECORD_FILE,
  r2ReleaseReader,
  TEST_HOOKS_DEFINE,
} from "@oa/provision";
import { InventoryInstallsSchema } from "@oa/shared/provisioning";
// The node-readable copy of RELEASE_PUBKEY (provision keeps its own in
// src/internal/gates.ts, not exported; a test there pins the two equal).
import { RELEASE_PUBKEY } from "../../../scripts/ci/release-pubkeys.mjs";
import { describeRes, readBody } from "./http.ts";
import { type ProdProbe, prodSecretsOf } from "./targets.ts";

// prodClean (manager-approved spec, 2026-10-26). The positive proof that no
// prod install can run test hooks: every published prod release is the
// signed `release` variant with the hooks define false, its bytes match the
// signed sha, and they hold none of the hook SQL; every prod install's
// /healthz has no testHooks and its script lists no hook secret or var.
// Configured with zero releases or zero installs is a pass (Manager, user's
// decision 2026-10-30); a probe missing its R2 or inventory config, or a
// missing releases bucket, is a fail, never not-applicable.

const API = "https://api.cloudflare.com/client/v4";
const PREFIX = "releases/";
const FLOOR = "releases/floor.json";
const HOOK_NAMES = ["TEST_HOOK_KEY", "TEST_HOOKS"];
const MAX_KEYS = 200_000;

/**
 * Hook SQL only the redline bundle carries. Same strings as
 * apps/server/test/node/test-hooks-strip.test.ts MARKERS (a unit test pins
 * them equal).
 */
export const HOOK_SQL_MARKERS = [
  "substr(fu.email, length(fu.email) - length(?5)) <> '@' || ?5",
  "where substr(?1, 1, 5) = 'test-'",
  "and exists (select 1 from spaces where id = ?1 and kind = 'shared' and deleted_at is null)",
];

/** Every way prodClean fails; the only text a public log may carry. */
export const PROD_CLEAN_CODES = [
  "not_configured",
  "inventory_unconfigured",
  "bucket_missing",
  "release_dirty",
  "install_dirty",
  "inventory_bad",
  "unreachable",
] as const;
export type ProdCleanCode = (typeof PROD_CLEAN_CODES)[number];

/** The detail (`message`, at most 200) goes only to inventory's POST /prodclean. */
export class ProdDirty extends Error {
  override name = "ProdDirty";
  readonly code: ProdCleanCode;
  readonly installId?: string;
  constructor(code: ProdCleanCode, message: string, installId?: string) {
    super(message.slice(0, 200));
    this.code = code;
    if (installId !== undefined) this.installId = installId;
  }
}

/** The one line a public log shows: `prod-clean: pass` or `prod-clean: fail (<code>)`. */
export const prodCleanLine = (failCode?: string) =>
  failCode === undefined
    ? "prod-clean: pass"
    : `prod-clean: fail (${failCode})`;
export const PROD_CLEAN_LINE_RE =
  /^prod-clean: (pass|fail \([a-z][a-z0-9_]{0,39}\))$/;

export type ProdResult = { level: "pass"; releases: number; installs: number };

export interface ProdCleanOpts {
  /** Every request (Cloudflare API, inventory, /healthz) goes through this (tests). */
  fetch?: typeof fetch;
  /** The prod release public key (tests sign with their own). */
  pubkey?: string;
  /**
   * The inventory's GitHub OIDC bearer (a JWT the caller minted for the prod
   * inventory's audience). The only inventory credential: inventory accepts
   * no stored key, so a probe's loaded REDLINE_PROD_INVENTORY_KEY is never
   * sent, and without this the probe is inventory_unconfigured.
   */
  inventoryBearer?: string;
}

async function listKeys(cf: Cf, bucket: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    let page: Awaited<ReturnType<Cf["r2ObjectList"]>>;
    try {
      page = await cf.r2ObjectList(bucket, PREFIX, cursor);
    } catch (e) {
      // A configured probe whose releases bucket is missing: fail.
      if (e instanceof CfError && e.status === 404)
        throw new ProdDirty(
          "bucket_missing",
          `releases bucket ${bucket} missing`,
        );
      throw e;
    }
    for (const o of page.objects) out.push(o.key);
    if (out.length > MAX_KEYS)
      throw new ProdDirty("release_dirty", "releases bucket: too many keys");
    if (!page.truncated || !page.cursor) return out;
    cursor = page.cursor;
  }
}

/** The (version, variant) pairs under releases/; any other key shape is dirty. */
function releasesOf(keys: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const k of keys) {
    if (k === FLOOR) continue;
    const m = /^releases\/([^/]+)\/([^/]+)\/.+$/.exec(k);
    if (!m)
      throw new ProdDirty(
        "release_dirty",
        `releases bucket: unexpected key ${k.slice(0, 80)}`,
      );
    const [, version = "", variant = ""] = m;
    const s = out.get(version) ?? new Set<string>();
    s.add(variant);
    out.set(version, s);
  }
  return out;
}

async function checkRelease(
  cf: Cf,
  version: string,
  pubkey: string,
): Promise<void> {
  const reader = r2ReleaseReader(cf, "prod");
  const what = `release ${version.slice(0, 40)}`;
  const signed = await reader.record(version, "release");
  if (!signed)
    throw new ProdDirty("release_dirty", `${what}: no ${RECORD_FILE}`);
  let rec: ReturnType<typeof openReleaseRecord>;
  try {
    rec = openReleaseRecord(signed, pubkey, "prod");
  } catch {
    throw new ProdDirty(
      "release_dirty",
      `${what}: the signed record does not verify`,
    );
  }
  if (rec.version !== version || rec.variant !== "release")
    throw new ProdDirty(
      "release_dirty",
      `${what}: the record is not this version's release variant`,
    );
  if (rec.defines[TEST_HOOKS_DEFINE] !== false)
    throw new ProdDirty(
      "release_dirty",
      `${what}: ${TEST_HOOKS_DEFINE} is not false`,
    );
  const bundle = await reader.modules(version, "release");
  if (bundleSha256(bundle) !== rec.sha256)
    throw new ProdDirty(
      "release_dirty",
      `${what}: the bundle sha does not match the record`,
    );
  const dec = new TextDecoder();
  for (const m of bundle.modules) {
    const text = dec.decode(m.bytes);
    for (const marker of HOOK_SQL_MARKERS)
      if (text.includes(marker))
        throw new ProdDirty(
          "release_dirty",
          `${what}: module ${m.name.slice(0, 60)} holds hook SQL`,
        );
  }
}

async function getJson(
  f: typeof fetch,
  url: string,
  token: string | null,
  what: string,
  fail: { code: ProdCleanCode; installId?: string },
): Promise<Record<string, unknown>> {
  const res = await f(url, {
    redirect: "manual",
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  const text = await readBody(res);
  if (res.status !== 200)
    throw new ProdDirty(
      fail.code,
      `prodClean ${what}: ${describeRes(res, text)}`,
      fail.installId,
    );
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object") throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ProdDirty(
      fail.code,
      `prodClean ${what}: not JSON (${describeRes(res, text)})`,
      fail.installId,
    );
  }
}

/**
 * pass, or throws ProdDirty (fail). An undefined probe (no R2 config) and a
 * probe without its inventory URL or bearer fail before any request.
 */
export async function prodClean(
  p: ProdProbe | undefined,
  o: ProdCleanOpts = {},
): Promise<ProdResult> {
  if (!p) throw new ProdDirty("not_configured", "prod probe not configured");
  const s = prodSecretsOf(p);
  const f = o.fetch ?? fetch;
  const pubkey = o.pubkey ?? RELEASE_PUBKEY.prod;
  // Only a GitHub OIDC JWT for the prod inventory's audience; never the
  // stored inventory key, which inventory rejects.
  const bearer = o.inventoryBearer;
  if (!p.inventoryUrl || !bearer)
    throw new ProdDirty(
      "inventory_unconfigured",
      "prod probe: inventory not configured",
    );

  // 1. Releases: every one must be the signed, hook-free release variant.
  const r2 = cfClient({ accountId: p.accountId, token: s.r2Token, fetch: f });
  const bucket = platformNames("prod").releases;
  const keys = await listKeys(r2, bucket);
  const releases = releasesOf(keys);
  for (const [version, variants] of releases)
    for (const v of variants)
      if (v !== "release")
        throw new ProdDirty(
          "release_dirty",
          `release ${version.slice(0, 40)}: variant ${v.slice(0, 20)} in prod`,
        );
  for (const version of releases.keys())
    await checkRelease(r2, version, pubkey);

  // 2. Installs: no hooks reachable, no hook secret or var.
  const inv = InventoryInstallsSchema.safeParse(
    await getJson(f, `${p.inventoryUrl}/installs`, bearer, "inventory", {
      code: "inventory_bad",
    }),
  );
  if (!inv.success)
    throw new ProdDirty(
      "inventory_bad",
      "prodClean inventory: not the installs schema",
    );
  const rows = inv.data.installs;
  const scripts = cfClient({
    accountId: p.accountId,
    token: s.scriptsToken,
    fetch: f,
  });
  const ns = NAMESPACES.prod;
  for (const r of rows) {
    const id = r.id;
    if (!isInstallId(id))
      throw new ProdDirty(
        "inventory_bad",
        "prodClean: an inventory row has a bad id",
      );
    const dirty = (msg: string) =>
      new ProdDirty("install_dirty", `prodClean ${id}: ${msg}`, id);
    const script = names(id, "prod").script;
    if (r.testHooks !== false) throw dirty("inventory testHooks is not false");
    const h = await getJson(
      f,
      `https://${r.appHost}/healthz`,
      null,
      `${id} /healthz`,
      { code: "unreachable", installId: id },
    );
    if (h.testHooks === true) throw dirty("/healthz testHooks is true");
    if (h.installId !== id) throw dirty("/healthz installId differs");
    const secretNames = await scripts.secretList(
      { kind: "namespace", ns },
      script,
    );
    const set = await getJson(
      f,
      `${API}/accounts/${p.accountId}/workers/dispatch/namespaces/${encodeURIComponent(ns)}/scripts/${encodeURIComponent(script)}/settings`,
      s.scriptsToken,
      `${id} settings`,
      { code: "unreachable", installId: id },
    );
    const bindings = (
      set.result as { bindings?: { name?: unknown }[] } | undefined
    )?.bindings;
    if (!Array.isArray(bindings)) throw dirty("settings unreadable");
    for (const n of [...secretNames, ...bindings.map((b) => b.name)])
      if (HOOK_NAMES.includes(String(n)))
        throw dirty(`script lists ${String(n)}`);
  }

  return { level: "pass", releases: releases.size, installs: rows.length };
}

/**
 * The red-line guard's case: local mode has no prod (not-applicable); staging
 * always runs prodClean, so a missing prod probe fails (not_configured) and
 * a probe with no OIDC inventory bearer fails (inventory_unconfigured).
 */
export async function guardProdClean(
  t: { mode: "local" | "staging"; prod?: ProdProbe },
  check: (p: ProdProbe | undefined) => Promise<ProdResult> = prodClean,
): Promise<"not-applicable" | ProdResult> {
  if (t.mode !== "staging") return "not-applicable";
  return check(t.prod);
}
