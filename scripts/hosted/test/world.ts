// The CLI's test world: provision's in-memory Cloudflare, a signed release
// store (the shape of wfp-lifecycle.test.ts's harness), a stub keychain and
// git, and every value a run generates or holds secret, for the output scan.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  assetEntries,
  bundleSha256,
  canonicalJson,
  cfClient,
  type Env,
  hostsKvTitle,
  migrationsSha256,
  platformNames,
  type ReleaseReader,
  type ReleaseRecord,
  TEST_HOOKS_DEFINE,
} from "@oa/provision";
import { FakeCf } from "../../../packages/provision/test/fake-cf.ts";
import type { Deps } from "../src/cli.ts";

export const NOW = Date.parse("2026-10-26T00:00:00Z");
const ROOT = new URL("../../../", import.meta.url);
const enc = (s: string) => new TextEncoder().encode(s);

const PLATFORM_SQL = readdirSync(new URL("apps/platform-db/migrations/", ROOT))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) =>
    readFileSync(new URL(`apps/platform-db/migrations/${f}`, ROOT), "utf8"),
  )
  .join("\n");
const MIGRATIONS = readdirSync(new URL("apps/server/migrations/", ROOT))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({
    name,
    bytes: new Uint8Array(
      readFileSync(new URL(`apps/server/migrations/${name}`, ROOT)),
    ),
  }));
const TEMPLATE = new Uint8Array(
  readFileSync(new URL("apps/server/wrangler.template.jsonc", ROOT)),
);
const ASSETS = [{ path: "index.html", bytes: enc("<!doctype html><p>hi</p>") }];
const WELCOME = enc("# Welcome to Open Artifacts\n");

const bundleOf = (variant: "release" | "redline", version: string) => ({
  modules: [
    {
      name: "index.js",
      type: "esm" as const,
      bytes: enc(
        `const hooksAllowed = ${variant === "redline"};\n// ${version}\nexport default { fetch() { return new Response(String(hooksAllowed)); } };\n`,
      ),
    },
  ],
  mainModule: "index.js",
  version,
});

export const SIGNER = generateKeyPairSync("ed25519");
export const PUB = SIGNER.publicKey.export({ format: "jwk" }).x as string;

export const SECURITY = "/usr/bin/security";
export const KEYCHAIN_ACCOUNT = "open-artifacts";

export const signed = (domain: string, env: string, v: unknown) => {
  const s = canonicalJson(v);
  return {
    record: s,
    signature: sign(
      null,
      Buffer.from(`${domain}\n${env}\n${s}`),
      SIGNER.privateKey,
    ).toString("base64url"),
  };
};

const recordOf = (
  env: Env,
  variant: "release" | "redline",
  version: string,
): ReleaseRecord => ({
  env,
  version,
  variant,
  sha256: bundleSha256(bundleOf(variant, version)),
  defines: { [TEST_HOOKS_DEFINE]: variant === "redline" },
  assets: assetEntries(ASSETS),
  templateSha256: createHash("sha256").update(TEMPLATE).digest("hex"),
  migrationsSha256: migrationsSha256(MIGRATIONS),
  welcomeSha256: createHash("sha256").update(WELCOME).digest("hex"),
});

function releases(env: Env): ReleaseReader {
  return {
    record: async (version, variant) =>
      signed("oa-release-v1", env, recordOf(env, variant, version)),
    modules: async (version, variant) => {
      const b = bundleOf(variant, version);
      return { mainModule: b.mainModule, modules: b.modules };
    },
    assets: async () => ASSETS.map((a) => ({ ...a, bytes: a.bytes.slice() })),
    template: async () => TEMPLATE.slice(),
    migrations: async () =>
      MIGRATIONS.map((f) => ({ ...f, bytes: f.bytes.slice() })),
    welcome: async () => WELCOME.slice(),
    floor: async () =>
      signed("oa-release-floor-v1", env, {
        env,
        seq: 1,
        minVersion: "0.1.0",
        revoked: [],
      }),
  };
}

export const ACTOR = "ops@example.com";

export function world(
  o: { env?: Env; ci?: boolean; keychainWriteNoop?: boolean } = {},
) {
  const env = o.env ?? "staging";
  const fake = new FakeCf({ now: NOW });
  const pdb = fake.seedD1(platformNames(env).db, PLATFORM_SQL);
  const hostsId = fake.seedKv(hostsKvTitle(env));
  const regId = fake.seedKv(platformNames(env).registry);
  const dirId = fake.seedKv(platformNames(env).directoryRegistry);
  fake.r2.add(platformNames(env).releases);
  fake.dispatch = { hostsKvId: hostsId, ns: `oa-${env}` };
  const home = mkdtempSync(join(tmpdir(), "oa-hosted-home-"));
  const lines: string[] = [];
  const errLines: string[] = [];
  const execs: { file: string; args: string[]; input?: string }[] = [];
  /** Keychain items by service name. */
  const keychain = new Map<string, string>([[`oa-hosted-${env}`, fake.token]]);
  const files = new Map<
    string,
    {
      bytes: Uint8Array;
      info: { mode: number; uid: number; isFile: boolean };
      symlink?: boolean;
    }
  >();
  const cfCalls: { accountId: string }[] = [];
  let t = NOW;
  const deps: Deps = {
    out: (l) => lines.push(l),
    err: (l) => errLines.push(l),
    env: {
      CLOUDFLARE_ACCOUNT_ID: fake.accountId,
      ...(o.ci
        ? {
            CI: "true",
            GITHUB_SERVER_URL: "https://github.com",
            GITHUB_REPOSITORY: "open-artifacts-ai/open-artifacts",
            GITHUB_RUN_ID: "42",
          }
        : {}),
    },
    home,
    uid: 501,
    execFile: async (file, args, opt) => {
      execs.push({ file, args, ...(opt?.input ? { input: opt.input } : {}) });
      if (file === "git") return `${ACTOR}\n`;
      if (file === SECURITY && args[0] === "find-generic-password") {
        // The real items carry the account open-artifacts; another misses.
        if (
          args[args.indexOf("-a") + 1] !== KEYCHAIN_ACCOUNT ||
          !args.includes("-a")
        )
          throw new Error("security exited 44");
        const v = keychain.get(args[args.indexOf("-s") + 1] as string);
        if (v === undefined) throw new Error("security exited 44");
        return `${v}\n`;
      }
      if (file === SECURITY && args[0] === "-i") {
        if (o.keychainWriteNoop) return "";
        const m = opt?.input?.match(/-a (\S+) -s (\S+) -w (\S+)\n$/);
        if (!m) throw new Error("bad security -i input");
        if (m[1] !== KEYCHAIN_ACCOUNT) throw new Error("wrong account");
        keychain.set(m[2] as string, m[3] as string);
        return "";
      }
      throw new Error(`unexpected exec ${file}`);
    },
    openNoFollow: (p) => {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (f.symlink) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
      return { info: f.info, read: () => f.bytes, close: () => {} };
    },
    readFile: (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`no file ${p}`);
      return f.bytes;
    },
    tempDir: () => mkdtempSync(join(tmpdir(), "oa-hosted-tmp-")),
    listDir: (dir) => readdirSync(dir),
    removeTree: () => {},
    cf: (c) => {
      cfCalls.push({ accountId: c.accountId });
      return cfClient({ ...c, fetch: fake.fetch, sleep: async () => {} });
    },
    release: (_cf, e) => releases(e),
    fetch: fake.fetch,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  const db = () => (fake.d1.get(pdb) as { db: DatabaseSync }).db;
  return {
    env,
    fake,
    deps,
    lines,
    errLines,
    execs,
    keychain,
    files,
    cfCalls,
    home,
    db,
    regId,
    dirId,
    parsed: () => lines.map((l) => JSON.parse(l)),
    audit: () =>
      db()
        .prepare(
          "SELECT actor, install_id, action FROM hosted_audit WHERE actor IS NOT NULL ORDER BY id",
        )
        .all() as { actor: string; install_id: string; action: string }[],
  };
}
