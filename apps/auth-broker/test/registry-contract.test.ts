// Contract: an entry built and keyed by provision's own code (the writer)
// is the entry the broker's lookupInstall (the reader) returns. Both brokers
// read install:<id> (sign-in on BROKER_REGISTRY, directory on
// DIRECTORY_REGISTRY), and provision writes both KVs through registryKey.
// lookupInstall comes from wherever the auth broker imports it. After
// Backend's T12 this test must target broker-core's lookupInstall, which
// #564 tightens: when `domains` is present it must be an array of at most
// 50 strings. Provision always writes `domains` (sorted, [] when none).
import { env } from "cloudflare:workers";
import { keyId, publicFromPkcs8 } from "@oa/auth-core";
import { registryEntry, registryKey } from "@oa/provision/names";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegistryCache, lookupInstall } from "../src/registry.js";

const ID = "iabc123def45";
const ORIGIN = "https://acme.open-artifacts-staging.app";
const pk = Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"),
  Buffer.alloc(32, 7),
]).toString("base64url");

async function provisioned(disabled?: boolean, domains: string[] = []) {
  const x = await publicFromPkcs8(pk);
  const entry = registryEntry({
    installId: ID,
    origin: ORIGIN,
    keys: [{ kid: await keyId(x), x }],
    domains,
    disabled,
  });
  await env.BROKER_REGISTRY.put(registryKey(ID), JSON.stringify(entry));
  return entry;
}

describe("registry contract with @oa/provision", () => {
  beforeEach(async () => {
    clearRegistryCache();
    await env.BROKER_REGISTRY.delete(registryKey(ID));
  });

  it("finds the entry provision writes, under the key provision uses", async () => {
    const entry = await provisioned();
    expect(await lookupInstall(env.BROKER_REGISTRY, ID)).toEqual(entry);
  });

  it("an entry with domains: [] still validates for sign-in", async () => {
    await provisioned(false, []);
    const got = await lookupInstall(env.BROKER_REGISTRY, ID);
    expect(got).not.toBeNull();
    expect(got?.domains).toEqual([]);
  });

  it("a legacy entry with no domains field (written before H-RD) still validates for sign-in", async () => {
    const { domains: _, ...legacy } = await provisioned();
    await env.BROKER_REGISTRY.put(registryKey(ID), JSON.stringify(legacy));
    clearRegistryCache();
    const got = await lookupInstall(env.BROKER_REGISTRY, ID);
    expect(got).toEqual(legacy);
    expect(got && "domains" in got).toBe(false);
  });

  it("returns the domains provision writes, intact", async () => {
    const entry = await provisioned(false, ["b.example", "a.example"]);
    const got = await lookupInstall(env.BROKER_REGISTRY, ID);
    expect(got).toEqual(entry);
    expect(got?.domains).toEqual(["a.example", "b.example"]);
  });

  it("returns both keys of a 2-key rotation entry from provision", async () => {
    const keys = [];
    for (const fill of [8, 9]) {
      const x = await publicFromPkcs8(
        Buffer.concat([
          Buffer.from("302e020100300506032b657004220420", "hex"),
          Buffer.alloc(32, fill),
        ]).toString("base64url"),
      );
      keys.push({ kid: await keyId(x), x });
    }
    const entry = registryEntry({
      installId: ID,
      origin: ORIGIN,
      keys,
      domains: ["a.example", "xn--bcher-kva.example"],
    });
    await env.BROKER_REGISTRY.put(registryKey(ID), JSON.stringify(entry));
    const got = await lookupInstall(env.BROKER_REGISTRY, ID);
    expect(got).toEqual(entry);
    expect(got?.keys).toEqual(keys);
    expect(got?.keys).toHaveLength(2);
    expect(got?.domains).toEqual(["a.example", "xn--bcher-kva.example"]);
  });

  it("a disabled entry from provision is not trusted", async () => {
    await provisioned(true);
    expect(await lookupInstall(env.BROKER_REGISTRY, ID)).toBeNull();
  });
});
