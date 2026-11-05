// Contract: an entry built and keyed by provision's own code (the writer)
// is the entry the broker's lookupInstall (the reader) returns. Both brokers
// read install:<id> (sign-in on BROKER_REGISTRY, directory on
// DIRECTORY_REGISTRY), and provision writes both KVs through registryKey.
// lookupInstall comes from wherever the auth broker imports it (broker-core,
// which #564 tightens: when `domains` is present it must be an array of at
// most 50 strings). Provision always writes `domains` (sorted, [] when none).
//
// Moved from apps/auth-broker/test/registry-contract.test.ts (#1056): the
// broker is public and must not depend on @oa/provision, so the contract
// lives on the hosted side, in the provisioner (the registry's writer), and
// reads the broker and @oa/auth-core by relative path. As the provisioner's
// other suites do, it builds its own binding: an in-memory KV with the one
// method the reader calls (get(key, "json")), plus put and delete.
import { registryEntry, registryKey } from "@oa/provision/names";
import { beforeEach, describe, expect, it } from "vitest";
import {
  keyId,
  publicFromPkcs8,
} from "../../../packages/auth-core/src/index.js";
import {
  clearRegistryCache,
  lookupInstall,
} from "../../auth-broker/src/registry.js";

/** The KV surface lookupInstall uses, in memory. */
function memoryKv() {
  const m = new Map<string, string>();
  return {
    async get(key: string, type: "json") {
      expect(type).toBe("json");
      const v = m.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
  };
}
const kv = memoryKv();
type Kv = Parameters<typeof lookupInstall>[0];
const env = { BROKER_REGISTRY: kv as unknown as Kv & typeof kv };

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
