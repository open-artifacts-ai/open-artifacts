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
// An unreleased or empty prod is not-applicable, never pass.

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

export class ProdDirty extends Error {
  override name = "ProdDirty";
}

export type ProdResult =
  | { level: "pass"; releases: number; installs: number }
  | { level: "not-applicable"; reason: string };

export interface ProdCleanOpts {
  /** Every request (Cloudflare API, inventory, /healthz) goes through this (tests). */
  fetch?: typeof fetch;
  /** The prod release public key (tests sign with their own). */
  pubkey?: string;
}

const NOT_UP = "prod not brought up";

async function listKeys(cf: Cf, bucket: string): Promise<string[] | null> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    let page: Awaited<ReturnType<Cf["r2ObjectList"]>>;
    try {
      page = await cf.r2ObjectList(bucket, PREFIX, cursor);
    } catch (e) {
      // A missing bucket: prod was never brought up.
      if (e instanceof CfError && e.status === 404) return null;
      throw e;
    }
    for (const o of page.objects) out.push(o.key);
    if (out.length > MAX_KEYS)
      throw new ProdDirty("releases bucket: too many keys");
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
      throw new ProdDirty(`releases bucket: unexpected key ${k.slice(0, 80)}`);
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
  if (!signed) throw new ProdDirty(`${what}: no ${RECORD_FILE}`);
  let rec: ReturnType<typeof openReleaseRecord>;
  try {
    rec = openReleaseRecord(signed, pubkey, "prod");
  } catch {
    throw new ProdDirty(`${what}: the signed record does not verify`);
  }
  if (rec.version !== version || rec.variant !== "release")
    throw new ProdDirty(
      `${what}: the record is not this version's release variant`,
    );
  if (rec.defines[TEST_HOOKS_DEFINE] !== false)
    throw new ProdDirty(`${what}: ${TEST_HOOKS_DEFINE} is not false`);
  const bundle = await reader.modules(version, "release");
  if (bundleSha256(bundle) !== rec.sha256)
    throw new ProdDirty(`${what}: the bundle sha does not match the record`);
  const dec = new TextDecoder();
  for (const m of bundle.modules) {
    const text = dec.decode(m.bytes);
    for (const marker of HOOK_SQL_MARKERS)
      if (text.includes(marker))
        throw new ProdDirty(
          `${what}: module ${m.name.slice(0, 60)} holds hook SQL`,
        );
  }
}

async function getJson(
  f: typeof fetch,
  url: string,
  token: string | null,
  what: string,
): Promise<Record<string, unknown>> {
  const res = await f(url, {
    redirect: "manual",
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  const text = await readBody(res);
  if (res.status !== 200)
    throw new ProdDirty(`prodClean ${what}: ${describeRes(res, text)}`);
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object") throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ProdDirty(
      `prodClean ${what}: not JSON (${describeRes(res, text)})`,
    );
  }
}

/** pass, not-applicable ("prod not brought up"), or throws ProdDirty (fail). */
export async function prodClean(
  p: ProdProbe,
  o: ProdCleanOpts = {},
): Promise<ProdResult> {
  const s = prodSecretsOf(p);
  const f = o.fetch ?? fetch;
  const pubkey = o.pubkey ?? RELEASE_PUBKEY.prod;

  // 1. Releases: every one must be the signed, hook-free release variant.
  const r2 = cfClient({ accountId: p.accountId, token: s.r2Token, fetch: f });
  const bucket = platformNames("prod").releases;
  const keys = await listKeys(r2, bucket);
  const releases = keys ? releasesOf(keys) : new Map<string, Set<string>>();
  for (const [version, variants] of releases)
    for (const v of variants)
      if (v !== "release")
        throw new ProdDirty(
          `release ${version.slice(0, 40)}: variant ${v.slice(0, 20)} in prod`,
        );
  for (const version of releases.keys())
    await checkRelease(r2, version, pubkey);

  // 2. Installs: no hooks reachable, no hook secret or var.
  let rows: Record<string, unknown>[] = [];
  if (p.inventoryUrl && s.inventoryKey) {
    const inv = await getJson(
      f,
      `${p.inventoryUrl}/installs`,
      s.inventoryKey,
      "inventory",
    );
    if (!Array.isArray(inv.installs))
      throw new ProdDirty("prodClean inventory: no installs array");
    rows = inv.installs as Record<string, unknown>[];
  }
  const scripts = cfClient({
    accountId: p.accountId,
    token: s.scriptsToken,
    fetch: f,
  });
  const ns = NAMESPACES.prod;
  for (const r of rows) {
    const id = String(r.id ?? "");
    if (!isInstallId(id))
      throw new ProdDirty("prodClean: an inventory row has a bad id");
    const script = names(id, "prod").script;
    if (r.testHooks !== false)
      throw new ProdDirty(`prodClean ${id}: inventory testHooks is not false`);
    const h = await getJson(
      f,
      `https://${String(r.appHost)}/healthz`,
      null,
      `${id} /healthz`,
    );
    if (h.testHooks === true)
      throw new ProdDirty(`prodClean ${id}: /healthz testHooks is true`);
    if (h.installId !== id)
      throw new ProdDirty(`prodClean ${id}: /healthz installId differs`);
    const secretNames = await scripts.secretList(
      { kind: "namespace", ns },
      script,
    );
    const set = await getJson(
      f,
      `${API}/accounts/${p.accountId}/workers/dispatch/namespaces/${encodeURIComponent(ns)}/scripts/${encodeURIComponent(script)}/settings`,
      s.scriptsToken,
      `${id} settings`,
    );
    const bindings = (
      set.result as { bindings?: { name?: unknown }[] } | undefined
    )?.bindings;
    if (!Array.isArray(bindings))
      throw new ProdDirty(`prodClean ${id}: settings unreadable`);
    for (const n of [...secretNames, ...bindings.map((b) => b.name)])
      if (HOOK_NAMES.includes(String(n)))
        throw new ProdDirty(`prodClean ${id}: script lists ${String(n)}`);
  }

  if (releases.size === 0 || rows.length === 0)
    return {
      level: "not-applicable",
      reason:
        !p.inventoryUrl && releases.size > 0
          ? `${NOT_UP} (inventory not configured)`
          : NOT_UP,
    };
  return { level: "pass", releases: releases.size, installs: rows.length };
}
