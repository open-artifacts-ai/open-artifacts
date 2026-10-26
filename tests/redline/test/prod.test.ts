import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundleSha256,
  canonicalJson,
  platformNames,
  TEST_HOOKS_DEFINE,
} from "@oa/provision";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_SQL_MARKERS, ProdDirty, prodClean } from "../src/prod.ts";
import { parseTargets } from "../src/targets.ts";
import { type Fake, fakeServer, json, secretDir } from "./fake.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ACCT = "0123456789abcdef0123456789abcdef";
const BUCKET = platformNames("prod").releases;
const TEMPLATE = readFileSync(
  join(ROOT, "apps/server/wrangler.template.jsonc"),
);
const H64 = "a".repeat(64);
const ID = "iabcdefghijk";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format: "jwk" }).x as string;

const dispose: (() => unknown)[] = [];
afterEach(async () => {
  for (const d of dispose.splice(0)) await d();
});

interface World {
  /** Bucket objects by key; null = the bucket doesn't exist. */
  objects: Map<string, Uint8Array> | null;
  installs: Record<string, unknown>[];
  healthz: Record<string, unknown>;
  secretNames: string[];
  bindings: string[];
}

function signedRecord(o: {
  version: string;
  variant?: string;
  define?: boolean;
  sha256: string;
  key?: typeof privateKey;
}) {
  const record = canonicalJson({
    assets: [],
    defines: { [TEST_HOOKS_DEFINE]: o.define ?? false },
    env: "prod",
    migrationsSha256: H64,
    sha256: o.sha256,
    templateSha256: H64,
    variant: o.variant ?? "release",
    version: o.version,
    welcomeSha256: H64,
  });
  const signature = sign(
    null,
    Buffer.from(`oa-release-v1\nprod\n${record}`),
    o.key ?? privateKey,
  ).toString("base64url");
  return new TextEncoder().encode(JSON.stringify({ record, signature }));
}

/** One published release: modules/index.js, the template, the signed record. */
function publish(
  w: World,
  o: {
    version: string;
    variant?: string;
    js?: string;
    shaOf?: string;
    key?: typeof privateKey;
  },
) {
  const variant = o.variant ?? "release";
  const js = new TextEncoder().encode(o.js ?? "export default {};");
  const signedJs = new TextEncoder().encode(
    o.shaOf ?? o.js ?? "export default {};",
  );
  const sha = bundleSha256({
    mainModule: "index.js",
    modules: [{ name: "index.js", type: "esm", bytes: signedJs }],
  });
  const base = `releases/${o.version}/${variant}/`;
  const objs = w.objects ?? new Map();
  objs.set(`${base}modules/index.js`, js);
  objs.set(`${base}template/wrangler.template.jsonc`, TEMPLATE);
  objs.set(
    `${base}record.sig.json`,
    signedRecord({ version: o.version, variant, sha256: sha, key: o.key }),
  );
  w.objects = objs;
}

const cleanWorld = (): World => ({
  objects: new Map(),
  installs: [
    {
      id: ID,
      appHost: "acme.open-artifacts.app",
      contentHost: "c",
      state: "live",
      testHooks: false,
    },
  ],
  healthz: { ok: true, installId: ID },
  secretNames: ["SESSION_SECRET"],
  bindings: ["DB"],
});

/** A fake Cloudflare API + inventory + /healthz, reached through an injected fetch. */
async function serve(w: World): Promise<{ f: Fake; fetch: typeof fetch }> {
  const r2 = `/client/v4/accounts/${ACCT}/r2/buckets/${BUCKET}/objects`;
  const script = `/client/v4/accounts/${ACCT}/workers/dispatch/namespaces/oa-prod/scripts/oa-p-${ID}`;
  const f = await fakeServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === r2) {
      if (!w.objects)
        return json(res, 404, { success: false, errors: [{ code: 10006 }] });
      const prefix = u.searchParams.get("prefix") ?? "";
      const result = [...w.objects]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, b]) => ({ key, size: b.length, etag: "e" }));
      return json(res, 200, {
        success: true,
        result,
        result_info: { is_truncated: false },
      });
    }
    if (u.pathname.startsWith(`${r2}/`)) {
      const key = decodeURIComponent(u.pathname.slice(r2.length + 1));
      const b = w.objects?.get(key);
      if (!b) return json(res, 404, { success: false });
      return res.writeHead(200, { etag: '"e"' }).end(Buffer.from(b));
    }
    if (u.pathname === "/installs")
      return json(res, 200, { installs: w.installs });
    if (u.pathname === "/healthz") return json(res, 200, w.healthz);
    if (u.pathname === `${script}/secrets`)
      return json(res, 200, {
        success: true,
        result: w.secretNames.map((name) => ({ name, type: "secret_text" })),
      });
    if (u.pathname === `${script}/settings`)
      return json(res, 200, {
        success: true,
        result: { bindings: w.bindings.map((name) => ({ name })) },
      });
    json(res, 404, {});
  });
  dispose.push(() => f.close());
  const routed: typeof fetch = (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    return fetch(`${f.origin}${u.pathname}${u.search}`, init);
  };
  return { f, fetch: routed };
}

/** A staging REDLINE_TARGETS with the CI layout for prod. */
function probe(o: { inventory?: boolean } = {}) {
  const s = secretDir({
    REDLINE_RL_A_HOOK_KEY: "a".repeat(40),
    REDLINE_RL_B_HOOK_KEY: "b".repeat(40),
    REDLINE_PROD_R2_TOKEN: "r2-token",
    REDLINE_PROD_SCRIPTS_TOKEN: "scripts-token",
    REDLINE_PROD_INVENTORY_KEY: "inv-key",
  });
  dispose.push(s.cleanup);
  const t = (n: string, d: string) => ({
    name: n,
    installId: n,
    app: `https://${n}.open-artifacts-staging.app`,
    content: `https://${n}.open-artifacts-staging.page`,
    testDomain: d,
  });
  const T = parseTargets({
    REDLINE_PROD_ACCOUNT_ID: ACCT,
    REDLINE_TARGETS: JSON.stringify({
      secretsDir: s.dir,
      a: t("rl-a", "oa-redline-a.fyi"),
      b: t("rl-b", "oa-redline-c.fyi"),
      ...(o.inventory === false
        ? {}
        : { prod: { inventoryUrl: "https://inventory.example" } }),
    }),
  });
  if (!T.prod) throw new Error("no prod probe");
  return T.prod;
}

async function check(w: World, o: { inventory?: boolean } = {}) {
  const { fetch } = await serve(w);
  return prodClean(probe(o), { fetch, pubkey: PUB });
}

describe("prodClean (spec 2026-10-26)", () => {
  it("reads the CI layout: REDLINE_PROD_R2_TOKEN, _SCRIPTS_TOKEN and REDLINE_PROD_ACCOUNT_ID", () => {
    const p = probe();
    expect(p.accountId).toBe(ACCT);
    expect(p.r2TokenFile.endsWith("REDLINE_PROD_R2_TOKEN")).toBe(true);
    expect(p.scriptsTokenFile.endsWith("REDLINE_PROD_SCRIPTS_TOKEN")).toBe(
      true,
    );
    expect(JSON.stringify(p)).not.toContain("r2-token");
  });

  it("a clean prod (signed release, clean install) passes", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    expect(await check(w)).toEqual({ level: "pass", releases: 1, installs: 1 });
  });

  it("a missing bucket is not-applicable, never pass", async () => {
    const w = cleanWorld();
    w.objects = null;
    expect(await check(w)).toEqual({
      level: "not-applicable",
      reason: "prod not brought up",
    });
  });

  it("an empty bucket is not-applicable", async () => {
    expect((await check(cleanWorld())).level).toBe("not-applicable");
  });

  it("0 inventory rows is not-applicable", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    w.installs = [];
    expect(await check(w)).toEqual({
      level: "not-applicable",
      reason: "prod not brought up",
    });
  });

  it("a redline (or any non-release) variant in prod fails", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    publish(w, { version: "1.2.3", variant: "redline" });
    await expect(check(w)).rejects.toThrow(/variant redline in prod/);
    const w2 = cleanWorld();
    publish(w2, { version: "1.2.4", variant: "debug" });
    await expect(check(w2)).rejects.toThrow(ProdDirty);
  });

  it("a record signed by another key fails verification", async () => {
    const w = cleanWorld();
    publish(w, {
      version: "1.2.3",
      key: generateKeyPairSync("ed25519").privateKey,
    });
    await expect(check(w)).rejects.toThrow(/does not verify/);
  });

  it("bundle bytes that don't match the signed sha fail before any scan", async () => {
    const w = cleanWorld();
    publish(w, {
      version: "1.2.3",
      js: "export default 1;",
      shaOf: "export default 2;",
    });
    await expect(check(w)).rejects.toThrow(/sha does not match/);
  });

  it("a module holding hook SQL fails", async () => {
    for (const m of HOOK_SQL_MARKERS) {
      const w = cleanWorld();
      publish(w, { version: "1.2.3", js: `const q = "${m}";` });
      await expect(check(w)).rejects.toThrow(/holds hook SQL/);
    }
  });

  it("an install whose script lists TEST_HOOK_KEY or binds TEST_HOOKS fails", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    w.secretNames = ["SESSION_SECRET", "TEST_HOOK_KEY"];
    await expect(check(w)).rejects.toThrow(/lists TEST_HOOK_KEY/);
    w.secretNames = ["SESSION_SECRET"];
    w.bindings = ["DB", "TEST_HOOKS"];
    await expect(check(w)).rejects.toThrow(/lists TEST_HOOKS/);
  });

  it("an install with /healthz testHooks: true, or another installId, fails", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    w.healthz = { ok: true, installId: ID, testHooks: true };
    await expect(check(w)).rejects.toThrow(/testHooks is true/);
    w.healthz = { ok: true, installId: "iother000000" };
    await expect(check(w)).rejects.toThrow(/installId differs/);
  });

  it("a release with no inventory configured is not-applicable", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    expect((await check(w, { inventory: false })).level).toBe("not-applicable");
  });

  it("the hook SQL markers equal the server's strip test", () => {
    const src = readFileSync(
      join(ROOT, "apps/server/test/node/test-hooks-strip.test.ts"),
      "utf8",
    );
    for (const m of HOOK_SQL_MARKERS) expect(src).toContain(JSON.stringify(m));
  });
});
