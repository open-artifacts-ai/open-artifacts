import { describe, expect, it } from "vitest";
import {
  assertOwnResource,
  ENV_PREFIX,
  ForeignResource,
  hosts,
  hostsKvTitle,
  hostsValue,
  isInstallId,
  isPlatformPrincipalId,
  names,
  newInstallId,
  PLATFORM_PRINCIPAL_IDS,
  parseHostsValue,
  platformNames,
  STAGING_TEST_DOMAIN,
} from "../src/index.js";
import * as namesEntry from "../src/names.js";

const D = { app: "app.test", content: "content.test" };

describe("provision names", () => {
  it("install ids are 12 chars, lowercase, i-prefixed", () => {
    for (let n = 0; n < 200; n++)
      expect(isInstallId(newInstallId())).toBe(true);
    expect(isInstallId("I0123456789a")).toBe(false);
  });
  it("names are derived only from the id and env", () => {
    expect(names("iabc123def45", "staging")).toEqual({
      script: "oa-s-iabc123def45",
      d1: "oa-s-iabc123def45",
      r2: "oa-s-iabc123def45",
      kv: "oa-s-iabc123def45-oauth",
    });
    expect(names("iabc123def45", "prod")).toEqual({
      script: "oa-p-iabc123def45",
      d1: "oa-p-iabc123def45",
      r2: "oa-p-iabc123def45",
      kv: "oa-p-iabc123def45-oauth",
    });
  });
  it("platformNames per env", () => {
    expect(platformNames("staging")).toEqual({
      db: "oa-s-platform",
      releases: "oa-s-releases",
      registry: "oa-s-broker-registry",
      scheduler: "oa-s-scheduler",
      inventory: "oa-s-inventory",
      broker: "oa-s-auth-broker",
      directoryBroker: "oa-s-directory-broker",
      directoryRegistry: "oa-s-directory-registry",
      dispatch: "oa-s-dispatch",
      hosts: "oa-s-hosts",
      turnstile: "oa-s-turnstile",
      provisionToken: "oa-s-provision-token",
    });
    expect(platformNames("prod").provisionToken).toBe("oa-p-provision-token");
    expect(platformNames("prod").turnstile).toBe("oa-p-turnstile");
    expect(platformNames("prod").db).toBe("oa-p-platform");
    expect(platformNames("prod").hosts).toBe("oa-p-hosts");
    expect(platformNames("prod").directoryBroker).toBe("oa-p-directory-broker");
    expect(platformNames("prod").directoryRegistry).toBe(
      "oa-p-directory-registry",
    );
    // H-DR: the directory broker binds a copy, never the sign-in registry.
    for (const env of ["staging", "prod"] as const)
      expect(platformNames(env).directoryRegistry).not.toBe(
        platformNames(env).registry,
      );
    // Create and delete write HOSTS under the same title the dispatch Worker binds.
    expect(hostsKvTitle("staging")).toBe(platformNames("staging").hosts);
    expect(hostsKvTitle("prod")).toBe(platformNames("prod").hosts);
    for (const env of ["staging", "prod"] as const) {
      const other = env === "staging" ? "prod" : "staging";
      for (const v of Object.values(platformNames(env))) {
        expect(() => assertOwnResource(v, env)).not.toThrow();
        expect(() => assertOwnResource(v, other)).toThrow(ForeignResource);
      }
    }
  });
  it("assertOwnResource refuses foreign and near-miss names", () => {
    expect(ENV_PREFIX).toEqual({ staging: "oa-s-", prod: "oa-p-" });
    for (const n of [
      "oa-p-x",
      "open-artifacts",
      "open-artifacts-staging",
      "open-artifacts-demo",
      "terrazul-api",
      "leourbina",
      "oa-",
      "",
      "oa-s",
      "oa-sx-abc",
      " oa-s-abc",
      "OA-S-abc",
    ])
      expect(() => assertOwnResource(n, "staging")).toThrow(ForeignResource);
    expect(() => assertOwnResource("oa-s-x", "prod")).toThrow(ForeignResource);
    expect(new ForeignResource("x").name).toBe("ForeignResource");
    expect(() => assertOwnResource("oa-s-x", "staging")).not.toThrow();
  });
  it("every generated name passes for its own env", () => {
    for (let n = 0; n < 200; n++) {
      const id = newInstallId();
      for (const env of ["staging", "prod"] as const)
        for (const v of Object.values(names(id, env)))
          expect(() => assertOwnResource(v, env)).not.toThrow();
    }
  });
  it("rejects reserved, uppercase, dotted and too-long slugs", () => {
    for (const s of [
      "www",
      "auth",
      "broker",
      "login",
      "sso",
      "directory",
      "Acme",
      "a.b",
      "-a",
      "a-",
      "x".repeat(33),
    ])
      expect(() => hosts(s, D)).toThrow(/slug/);
    expect(hosts("finqore", D)).toEqual({
      appHost: "finqore.app.test",
      contentHost: "finqore.content.test",
    });
  });
  it("refuses punycode and IDNA-reserved slugs (H-T4b L4)", () => {
    for (const s of ["xn--80ak6aa92e", "xn--a", "ab--c", "a1--", "zz--zz"])
      expect(() => hosts(s, D)).toThrow(/slug/);
    for (const s of ["a-b", "abc--d", "a--b", "x-n--a", "finqore"])
      expect(() => hosts(s, D)).not.toThrow();
  });
  it("refuses equal or nested app and content domains", () => {
    expect(() => hosts("a", { app: "x.test", content: "x.test" })).toThrow(
      /domain/,
    );
    expect(() => hosts("a", { app: "x.test", content: "c.x.test" })).toThrow(
      /domain/,
    );
    expect(() => hosts("a", { app: "c.x.test", content: "x.test" })).toThrow(
      /domain/,
    );
  });
});

describe("HOSTS values (5.5)", () => {
  const ID = "iabc123def45";
  it("parses <id>, paused:<id> and closed:<id>", () => {
    expect(parseHostsValue(ID)).toEqual({ installId: ID, mode: "serving" });
    expect(parseHostsValue(`paused:${ID}`)).toEqual({
      installId: ID,
      mode: "paused",
    });
    expect(parseHostsValue(`closed:${ID}`)).toEqual({
      installId: ID,
      mode: "closed",
    });
  });
  it.each([
    "",
    "serving:iabc123def45",
    "PAUSED:iabc123def45",
    "paused:",
    "paused:iabc123def4",
    "paused:iabc123def45 ",
    " iabc123def45",
    "paused:closed:iabc123def45",
    "iABC123def45",
    "unmapped:iabc123def45",
    "i000000admin",
    "paused:i000000admin",
    "i00000signup",
    "closed:i00000signup",
  ])("anything else is null: %j", (v) => {
    expect(parseHostsValue(v)).toBeNull();
  });
  it("non-strings are null", () => {
    for (const v of [null, undefined, 1, {}, ["iabc123def45"]])
      expect(parseHostsValue(v)).toBeNull();
  });
  it("hostsValue writes what parseHostsValue reads", () => {
    for (const mode of ["serving", "paused", "closed"] as const)
      expect(parseHostsValue(hostsValue(ID, mode))).toEqual({
        installId: ID,
        mode,
      });
    expect(hostsValue(ID, "serving")).toBe(ID);
    expect(() => hostsValue("nope" as never, "paused")).toThrow(/install id/);
    expect(() => hostsValue("i000000admin", "serving")).toThrow(
      /platform principal/,
    );
  });
  it("is on the workerd-safe @oa/provision/names entry", () => {
    expect(namesEntry.parseHostsValue).toBe(parseHostsValue);
  });
});

describe("platform principals (4.1)", () => {
  it("are exactly the admin and signup ids, valid install ids newInstallId never mints", () => {
    expect([...PLATFORM_PRINCIPAL_IDS]).toEqual([
      "i000000admin",
      "i00000signup",
    ]);
    for (const id of PLATFORM_PRINCIPAL_IDS) {
      expect(isInstallId(id)).toBe(true);
      expect(isPlatformPrincipalId(id)).toBe(true);
      // newInstallId's alphabet has no 0, 1, 8 or 9.
      expect(id).toMatch(/[0189]/);
    }
    expect(isPlatformPrincipalId("iabc123def45")).toBe(false);
    expect(isPlatformPrincipalId(newInstallId())).toBe(false);
    expect(Object.isFrozen(PLATFORM_PRINCIPAL_IDS)).toBe(true);
  });
});

describe("STAGING_TEST_DOMAIN (3.3)", () => {
  it("is a lowercase hostname on namesEntry too", () => {
    expect(STAGING_TEST_DOMAIN).toMatch(
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/,
    );
    expect(namesEntry.STAGING_TEST_DOMAIN).toBe(STAGING_TEST_DOMAIN);
  });
});
