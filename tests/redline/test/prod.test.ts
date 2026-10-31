import { spawnSync } from "node:child_process";
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
import {
  guardProdClean,
  HOOK_SQL_MARKERS,
  PROD_CLEAN_CODES,
  PROD_CLEAN_LINE_RE,
  ProdDirty,
  prodClean,
} from "../src/prod.ts";
import { prodCleanGate, run } from "../src/prod-clean-cli.ts";
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
  /** The authorization header of each /installs read. */
  inventoryAuth?: (string | undefined)[];
  /** /healthz status (a paused or closed host answers 503). */
  healthzStatus?: number;
  /** The dispatch script is gone (purged): its routes answer 404. */
  scriptMissing?: boolean;
  /** Paths requested, in order. */
  seen?: string[];
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
      state: "active",
      testHooks: false,
      mode: "serving",
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
    w.seen = [...(w.seen ?? []), u.pathname];
    if (w.scriptMissing && u.pathname.startsWith(`${script}/`))
      return json(res, 404, { success: false, errors: [{ code: 10007 }] });
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
    if (u.pathname === "/installs") {
      w.inventoryAuth = [...(w.inventoryAuth ?? []), req.headers.authorization];
      return json(res, 200, { installs: w.installs });
    }
    if (u.pathname === "/healthz")
      return json(res, w.healthzStatus ?? 200, w.healthz);
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
function probe(o: { inventory?: boolean; jwtFile?: string } = {}) {
  const s = secretDir({
    REDLINE_RL_A_HOOK_KEY: "a".repeat(40),
    REDLINE_RL_B_HOOK_KEY: "b".repeat(40),
    REDLINE_PROD_R2_TOKEN: "r2-token",
    REDLINE_PROD_SCRIPTS_TOKEN: "scripts-token",
    ...(o.jwtFile === undefined
      ? {}
      : { REDLINE_PROD_INVENTORY_OIDC: o.jwtFile }),
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

/** The minted GitHub OIDC JWT a configured caller passes (never a stored key). */
const JWT = "jwt.x.y";
const bearerOf = (o: { inventory?: boolean }) =>
  o.inventory === false ? {} : { inventoryBearer: JWT };

async function check(w: World, o: { inventory?: boolean } = {}) {
  const { fetch } = await serve(w);
  return prodClean(probe(o), { fetch, pubkey: PUB, ...bearerOf(o) });
}

/** The ProdDirty code a rejected promise carries. */
async function failCode(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (!(e instanceof ProdDirty)) throw new Error(`not ProdDirty: ${String(e)}`);
  return e.code;
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

  it("an inventory URL needs no REDLINE_PROD_INVENTORY_KEY file (OIDC only)", () => {
    const p = probe();
    expect(p.inventoryUrl).toBe("https://inventory.example");
    expect(Object.keys(p).sort()).toEqual([
      "accountId",
      "inventoryUrl",
      "r2TokenFile",
      "scriptsTokenFile",
    ]);
  });

  it("a clean prod (signed release, clean install) passes", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    expect(await check(w)).toEqual({ level: "pass", releases: 1, installs: 1 });
  });

  it("a missing bucket fails bucket_missing, never pass", async () => {
    const w = cleanWorld();
    w.objects = null;
    expect(await failCode(check(w))).toBe("bucket_missing");
  });

  it("configured with an empty bucket and 0 rows passes", async () => {
    const w = cleanWorld();
    w.installs = [];
    expect(await check(w)).toEqual({ level: "pass", releases: 0, installs: 0 });
  });

  it("an inventory that is not the installs schema fails inventory_bad", async () => {
    const w = cleanWorld();
    w.installs = [{ id: ID, appHost: "a", testHooks: false }];
    expect(await failCode(check(w))).toBe("inventory_bad");
  });

  it("the inventory bearer is only opts.inventoryBearer (OIDC), never the stored key", async () => {
    const w = cleanWorld();
    const { fetch } = await serve(w);
    await prodClean(probe(), { fetch, pubkey: PUB, inventoryBearer: JWT });
    expect(w.inventoryAuth).toEqual([`Bearer ${JWT}`]);
    // A probe with an inventory URL but no OIDC bearer is
    // unconfigured: it fails before any request and never sends the key.
    let calls = 0;
    const counted: typeof fetch = (i, init) => {
      calls++;
      return fetch(i, init);
    };
    expect(
      await failCode(prodClean(probe(), { fetch: counted, pubkey: PUB })),
    ).toBe("inventory_unconfigured");
    expect(calls).toBe(0);
    expect(w.inventoryAuth).toEqual([`Bearer ${JWT}`]);
  });

  it("an unconfigured probe fails before any request", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      throw new Error("no");
    }) as unknown as typeof fetch;
    expect(await failCode(prodClean(undefined, { fetch: f }))).toBe(
      "not_configured",
    );
    expect(
      await failCode(prodClean(probe({ inventory: false }), { fetch: f })),
    ).toBe("inventory_unconfigured");
    expect(calls).toBe(0);
  });

  it("a dirty install carries its code, id and a detail of at most 200", async () => {
    const w = cleanWorld();
    w.secretNames = ["TEST_HOOK_KEY"];
    const e = await check(w).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProdDirty);
    expect((e as ProdDirty).code).toBe("install_dirty");
    expect((e as ProdDirty).installId).toBe(ID);
    expect(new ProdDirty("unreachable", "x".repeat(300)).message).toHaveLength(
      200,
    );
    for (const c of PROD_CLEAN_CODES)
      expect(c).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });

  describe("truth table (2026-10-30: configured + zero = pass, unconfigured = fail)", () => {
    type Bucket = "404" | "empty" | "releases";
    const cases: {
      r2: boolean;
      bucket: Bucket;
      inv: boolean;
      rows: number;
      dirty: boolean;
    }[] = [];
    // Dirty needs something to be dirty: a release or a row.
    for (const r2 of [true, false])
      for (const bucket of ["404", "empty", "releases"] as Bucket[])
        for (const inv of [true, false])
          for (const rows of [0, 1])
            for (const dirty of [false, true])
              if (!dirty || bucket === "releases" || rows > 0)
                cases.push({ r2, bucket, inv, rows, dirty });
    const expected = (c: (typeof cases)[number]) => {
      if (!c.r2) return "not_configured";
      if (!c.inv) return "inventory_unconfigured";
      if (c.bucket === "404") return "bucket_missing";
      if (c.dirty)
        return c.bucket === "releases" ? "release_dirty" : "install_dirty";
      return "pass";
    };
    for (const c of cases) {
      const want = expected(c);
      it(`R2 ${c.r2 ? "yes" : "no"}, bucket ${c.bucket}, inventory ${c.inv ? "yes" : "no"}, rows ${c.rows}, dirty ${c.dirty ? "yes" : "no"} -> ${want}`, async () => {
        const w = cleanWorld();
        if (c.bucket === "404") w.objects = null;
        if (c.bucket === "releases")
          publish(w, {
            version: "1.2.3",
            ...(c.dirty ? { js: `const q = "${HOOK_SQL_MARKERS[0]}";` } : {}),
          });
        if (c.rows === 0) w.installs = [];
        if (c.dirty && c.bucket !== "releases") w.bindings = ["TEST_HOOKS"];
        const { fetch } = await serve(w);
        const p = c.r2 ? probe({ inventory: c.inv }) : undefined;
        const r = prodClean(p, {
          fetch,
          pubkey: PUB,
          ...bearerOf({ inventory: c.inv }),
        });
        if (want === "pass")
          expect(await r).toEqual({
            level: "pass",
            releases: c.bucket === "releases" ? 1 : 0,
            installs: c.rows,
          });
        else expect(await failCode(r)).toBe(want);
      });
    }
  });

  describe("the red-line guard", () => {
    const pass = { level: "pass", releases: 0, installs: 0 } as const;
    it("local mode is not-applicable and never probes", async () => {
      let n = 0;
      const r = await guardProdClean({ mode: "local" }, async () => {
        n++;
        return pass;
      });
      expect(r).toBe("not-applicable");
      expect(n).toBe(0);
    });
    it("staging with no prod probe fails: prod probe not configured", async () => {
      await expect(guardProdClean({ mode: "staging" })).rejects.toThrow(
        "prod probe not configured",
      );
    });
    it("staging with a probe but no OIDC bearer fails inventory_unconfigured", async () => {
      expect(
        await failCode(guardProdClean({ mode: "staging", prod: probe() })),
      ).toBe("inventory_unconfigured");
    });
    it("staging reads the minted OIDC JWT from the secrets dir (REDLINE_PROD_INVENTORY_OIDC)", async () => {
      const w = cleanWorld();
      publish(w, { version: "1.2.3" });
      const { fetch } = await serve(w);
      const p = probe({ jwtFile: `${JWT}\n` });
      expect(JSON.stringify(p)).not.toContain(JWT);
      const r = await guardProdClean({ mode: "staging", prod: p }, (x) =>
        prodClean(x, { fetch, pubkey: PUB }),
      );
      expect(r).toEqual({ level: "pass", releases: 1, installs: 1 });
      expect(w.inventoryAuth).toEqual([`Bearer ${JWT}`]);
    });
    it("an explicit opts.inventoryBearer wins over the secrets-dir JWT", async () => {
      const w = cleanWorld();
      const { fetch } = await serve(w);
      await prodClean(probe({ jwtFile: "file.jwt.z" }), {
        fetch,
        pubkey: PUB,
        inventoryBearer: JWT,
      });
      expect(w.inventoryAuth).toEqual([`Bearer ${JWT}`]);
    });
    it("staging with a probe runs prodClean on it", async () => {
      const p = probe();
      const seen: unknown[] = [];
      const r = await guardProdClean(
        { mode: "staging", prod: p },
        async (x) => {
          seen.push(x);
          return pass;
        },
      );
      expect(r).toEqual(pass);
      expect(seen).toEqual([p]);
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

  describe("rows that do not serve (suspended, deleting, deleted, failed, unmapped)", () => {
    const row = (state: string, mode: string | null) => ({
      ...cleanWorld().installs[0],
      state,
      mode,
    });
    const notServing: [string, string | null][] = [
      ["suspended", "paused"],
      ["deleting", "closed"],
      ["deleted", null],
      ["failed", null],
      ["active", null],
    ];
    for (const [state, mode] of notServing) {
      it(`${state}/${mode ?? "unmapped"}: no /healthz probe; a 503 page or a purged script passes`, async () => {
        const w = cleanWorld();
        w.installs = [row(state, mode)];
        w.healthzStatus = 503;
        w.scriptMissing = true;
        expect(await check(w)).toEqual({
          level: "pass",
          releases: 0,
          installs: 1,
        });
        expect(w.seen).not.toContain("/healthz");
      });
      it(`${state}/${mode ?? "unmapped"}: a script that still lists a hook fails`, async () => {
        const w = cleanWorld();
        w.installs = [row(state, mode)];
        w.healthzStatus = 503;
        w.secretNames = ["TEST_HOOK_KEY"];
        expect(await failCode(check(w))).toBe("install_dirty");
      });
      it(`${state}/${mode ?? "unmapped"}: testHooks not false fails`, async () => {
        const w = cleanWorld();
        w.installs = [{ ...row(state, mode), testHooks: true }];
        w.scriptMissing = true;
        expect(await failCode(check(w))).toBe("install_dirty");
      });
    }
    it("a serving row still needs /healthz 200 and its script", async () => {
      const w = cleanWorld();
      w.healthzStatus = 503;
      expect(await failCode(check(w))).toBe("unreachable");
      const w2 = cleanWorld();
      w2.scriptMissing = true;
      await expect(check(w2)).rejects.toThrow();
    });
  });

  it("a release with no inventory configured fails inventory_unconfigured", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    expect(await failCode(check(w, { inventory: false }))).toBe(
      "inventory_unconfigured",
    );
  });

  it("the hook SQL markers equal the server's strip test", () => {
    const src = readFileSync(
      join(ROOT, "apps/server/test/node/test-hooks-strip.test.ts"),
      "utf8",
    );
    for (const m of HOOK_SQL_MARKERS) expect(src).toContain(JSON.stringify(m));
  });
});

describe("prod-clean-cli: the hosted-ops precheck", () => {
  async function gate(
    w: World,
    op: string,
    o: { inventory?: boolean; fetch?: typeof fetch } = {},
  ) {
    const { fetch } = await serve(w);
    return prodCleanGate(op, probe(o), {
      fetch: o.fetch ?? fetch,
      pubkey: PUB,
      ...bearerOf(o),
    });
  }
  const released = () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    return w;
  };

  it("a pass is exit 0 for create and upgrade", async () => {
    for (const op of ["create", "upgrade"])
      expect(await gate(released(), op)).toEqual({
        code: 0,
        line: "prod-clean: pass",
      });
  });

  it("a dirty prod is exit 1 with only its code", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3", variant: "redline" });
    for (const op of ["create", "upgrade"])
      expect(await gate(w, op)).toEqual({
        code: 1,
        line: "prod-clean: fail (release_dirty)",
      });
  });

  it("configured with no install or no release passes, for create and upgrade", async () => {
    const w = released();
    w.installs = [];
    expect((await gate(w, "create")).code).toBe(0);
    expect((await gate(w, "upgrade")).code).toBe(0);
    expect((await gate(cleanWorld(), "create")).code).toBe(0);
  });

  it("no inventory configured is exit 1", async () => {
    expect(await gate(released(), "create", { inventory: false })).toEqual({
      code: 1,
      line: "prod-clean: fail (inventory_unconfigured)",
    });
  });

  it("an error (network, inventory down) is exit 1", async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError("down"));
    expect(await gate(released(), "create", { fetch: down })).toEqual({
      code: 1,
      line: "prod-clean: fail (error)",
    });
    const w = released();
    w.installs = "nope" as unknown as Record<string, unknown>[];
    expect(await gate(w, "create")).toEqual({
      code: 1,
      line: "prod-clean: fail (inventory_bad)",
    });
  });

  it("any other op is exit 1", async () => {
    expect((await gate(released(), "rollback")).code).toBe(1);
    expect((await gate(released(), "")).code).toBe(1);
  });

  it("every line is one of the two fixed forms, never a detail", async () => {
    const w = cleanWorld();
    publish(w, { version: "1.2.3" });
    w.secretNames = ["TEST_HOOK_KEY"];
    const v = await gate(w, "create");
    expect(v.line).toBe("prod-clean: fail (install_dirty)");
    expect(v.line).toMatch(PROD_CLEAN_LINE_RE);
    expect(v.line).not.toContain(ID);
  });

  it("run: reads the CI layout from env; an unconfigured probe is exit 1", async () => {
    const s = secretDir({
      REDLINE_PROD_R2_TOKEN: "r2-token",
      REDLINE_PROD_SCRIPTS_TOKEN: "scripts-token",
    });
    dispose.push(s.cleanup);
    const { fetch } = await serve(released());
    const lines: string[] = [];
    const io = {
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
    };
    const env = {
      OPS_OP: "upgrade",
      REDLINE_PROD_SECRETS_DIR: s.dir,
      REDLINE_PROD_ACCOUNT_ID: ACCT,
      REDLINE_PROD_INVENTORY_URL: "https://inventory.example",
    };
    expect(
      await run(env, io, { fetch, pubkey: PUB, inventoryBearer: JWT }),
    ).toBe(0);
    // The stored key file alone is not an inventory bearer.
    expect(await run(env, io, { fetch, pubkey: PUB })).toBe(1);
    expect(await run({ ...env, REDLINE_PROD_SECRETS_DIR: "" }, io)).toBe(1);
    expect(await run({ ...env, REDLINE_PROD_ACCOUNT_ID: "x" }, io)).toBe(1);
    expect(lines).toEqual([
      "prod-clean: pass",
      "prod-clean: fail (inventory_unconfigured)",
      "prod-clean: fail (not_configured)",
      "prod-clean: fail (not_configured)",
    ]);
  });

  it("runs under plain node: no probe is exit 1", () => {
    const r = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "src", "prod-clean-cli.ts")],
      {
        env: {
          PATH: process.env.PATH ?? "",
          OPS_OP: "create",
          NODE_NO_WARNINGS: "1",
        },
        encoding: "utf8",
      },
    );
    expect(r.stderr).toBe("prod-clean: fail (not_configured)\n");
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
  });
});
