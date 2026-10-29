import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { cfClient } from "../../../packages/provision/src/cf.js";
import { platformNames } from "../../../packages/provision/src/names.js";
import {
  FLOOR_KEY,
  RECORD_FILE,
  r2BindingReleaseReader,
  releaseKey,
  TEMPLATE_FILE,
  WELCOME_FILE,
} from "../../../packages/provision/src/publish.js";
import type {
  BundleVariant,
  ReleaseReader,
} from "../../../packages/provision/src/release.js";
import {
  HOSTED_DOMAINS,
  hostsKvTitle,
  NAMESPACES,
  WfpProvisioner,
} from "../../../packages/provision/src/wfp.js";
import { FakeCf } from "../../../packages/provision/test/fake-cf.js";
import {
  enc,
  releaseFixtures,
  TEST_PUBKEY,
} from "../../../packages/provision/test/fixtures/release.js";
import { d1Engines } from "./d1-engine.js";

// A full WfpProvisioner.create inside workerd (nodejs_compat), as the hosted
// provisioner Worker will run it: the fake Cloudflare answers every REST call,
// and its D1s are Miniflare D1s, not node:sqlite.

vi.mock("../../../packages/provision/src/internal/gates.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../packages/provision/src/internal/gates.js")
  >()),
  // A getter: the mock is hoisted above the fixture import it reads.
  get RELEASE_PUBKEY() {
    return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
  },
}));

const E = testEnv as unknown as {
  PLATFORM_DB: D1Database;
  INSTALL_DB: D1Database;
  RELEASES: R2Bucket;
  FIXTURE_TEMPLATE: string;
  FIXTURE_SERVER_MIGRATIONS: { name: string; text: string }[];
  FIXTURE_PLATFORM_SQL: string;
};
const NOW = Date.parse("2026-10-22T00:00:00Z");
const TS = { sitekey: "0x4AAAAAAAstagingSITEKEY", secret: "0x4AAAAAAAts-x" };
/** The provisioner's owner token label: ss-<signup ULID>. */
const SS_LABEL = "ss-01JBQ4ZKXW5V9R3M2N8P6T7Y0A";

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** Publishes one release from `from` into `bucket`, at the keys publish.ts writes. */
async function seedRelease(
  bucket: R2Bucket,
  from: ReleaseReader,
  version: string,
  variant: BundleVariant,
): Promise<void> {
  const at = (rel: string) => releaseKey(version, variant, rel);
  const { modules } = await from.modules(version, variant);
  for (const m of modules) await bucket.put(at(`modules/${m.name}`), m.bytes);
  for (const a of await from.assets(version, variant))
    await bucket.put(
      at(`assets/${a.path}`),
      await from.assetBytes(version, variant, a.path),
    );
  await bucket.put(at(TEMPLATE_FILE), await from.template(version, variant));
  for (const f of await from.migrations(version, variant))
    await bucket.put(at(`migrations/${f.name}`), f.bytes);
  await bucket.put(at(WELCOME_FILE), await from.welcome(version, variant));
  await bucket.put(FLOOR_KEY, json(await from.floor()));
  await bucket.put(at(RECORD_FILE), json(await from.record(version, variant)));
}

describe("workerd", () => {
  it("a full create runs in workerd", async () => {
    const fake = new FakeCf({
      now: NOW,
      sql: d1Engines([E.PLATFORM_DB, E.INSTALL_DB]),
    });
    const env = "staging";
    const pdb = fake.seedD1(platformNames(env).db, E.FIXTURE_PLATFORM_SQL);
    const hostsId = fake.seedKv(hostsKvTitle(env));
    fake.seedKv(platformNames(env).registry);
    fake.seedKv(platformNames(env).directoryRegistry);
    fake.turnstile.set(TS.sitekey, {
      sitekey: TS.sitekey,
      name: platformNames(env).turnstile,
      domains: [HOSTED_DOMAINS[env].app],
      mode: "managed",
      secret: TS.secret,
    });
    fake.dispatch = { hostsKvId: hostsId, ns: NAMESPACES[env] };
    const { makeRelease } = releaseFixtures({
      template: enc(E.FIXTURE_TEMPLATE),
      migrations: E.FIXTURE_SERVER_MIGRATIONS.map((f) => ({
        name: f.name,
        bytes: enc(f.text),
      })),
    });
    await seedRelease(E.RELEASES, makeRelease({ env }), "0.23.0", "release");
    let t = NOW;
    const p = new WfpProvisioner({
      cf: cfClient({
        accountId: fake.accountId,
        token: fake.token,
        fetch: fake.fetch,
        sleep: async () => {},
      }),
      env,
      target: { kind: "namespace", ns: NAMESPACES[env] },
      domains: HOSTED_DOMAINS[env],
      // As the provisioner Worker runs it: the R2 binding, no patDir, and
      // the selftest on an ss-<ULID> owner token.
      release: r2BindingReleaseReader(E.RELEASES, env),
      ciOwnerToken: { label: SS_LABEL },
      fetch: fake.fetch,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      turnstile: TS,
    });

    const inst = await p.create({
      slug: "finqore",
      ownerEmail: "owner@finqore.test",
      plan: "paid",
      vars: {},
      bundle: "release",
      version: "0.23.0",
    });

    const row = await E.PLATFORM_DB.prepare(
      "SELECT state FROM installs WHERE id = ?",
    )
      .bind(inst.id)
      .first<{ state: string }>();
    expect(row?.state).toBe("active");
    expect(fake.d1.has(pdb)).toBe(true);
    // Both hosts mapped: the dispatch KV and the platform hosts table.
    const hosts = fake.kvValues(hostsId);
    expect(hosts.get(inst.appHost)).toBe(inst.id);
    expect(hosts.get(inst.contentHost)).toBe(inst.id);
    const rows = await E.PLATFORM_DB.prepare(
      "SELECT host FROM hosts WHERE install_id = ? ORDER BY host",
    )
      .bind(inst.id)
      .all<{ host: string }>();
    expect(rows.results.map((r) => r.host)).toEqual(
      [inst.appHost, inst.contentHost].sort(),
    );
    // The install's own D1 is the Miniflare one: migrated, with the ss-<ULID>
    // owner token the MCP selftest authenticated with, revoked before the
    // lease was released.
    const tokens = await E.INSTALL_DB.prepare(
      "SELECT label, revoked_at FROM tokens",
    ).all<{ label: string; revoked_at: number | null }>();
    expect(tokens.results).toEqual([
      { label: SS_LABEL, revoked_at: expect.any(Number) },
    ]);
    expect(inst.patFile).toBeUndefined();
    expect(fake.log.length).toBeLessThan(400);
  });
});
