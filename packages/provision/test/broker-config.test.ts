// The brokers' wrangler.jsonc names and origins are the ones provision deploys
// and points installs at (platformNames, HOSTED_DOMAINS).
//
// Moved from apps/auth-broker/test/node/config.test.ts and
// apps/directory-broker/test/node/config.test.ts (#1056): the brokers are
// public and must not depend on @oa/provision. Their own config tests keep
// the same checks against pinned literals; these keep the link to provision.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { platformNames } from "../src/names.js";
import { HOSTED_DOMAINS } from "../src/wfp.js";

const apps = join(import.meta.dirname, "../../../apps");
// Strip // and /* */ comments outside strings.
const strip = (s: string) =>
  s.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_m, str) => str ?? "",
  );
// biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
const config = (app: string): any =>
  JSON.parse(strip(readFileSync(join(apps, app, "wrangler.jsonc"), "utf8")));
const ENVS = ["staging", "prod"] as const;

describe("auth-broker wrangler.jsonc", () => {
  const cfg = config("auth-broker");

  it("names each env's Worker and origin as provision does", () => {
    for (const env of ENVS) {
      const e = cfg.env[env];
      expect(e.name).toBe(platformNames(env).broker);
      expect(e.vars.BROKER_ORIGIN).toBe(
        `https://auth.${HOSTED_DOMAINS[env].app}`,
      );
    }
    expect(platformNames("staging").broker).toBe("oa-s-auth-broker");
    expect(platformNames("prod").broker).toBe("oa-p-auth-broker");
    expect(platformNames("staging").registry).toBe("oa-s-broker-registry");
    expect(platformNames("prod").registry).toBe("oa-p-broker-registry");
  });
});

describe("directory-broker wrangler.jsonc", () => {
  const cfg = config("directory-broker");
  // TODO: platformNames has no `directory` or `directoryRegistry` yet (it comes
  // with the registry provisioning PR #563); until then pin the literals and
  // check the prefix against an existing name.
  const P = { staging: "oa-s-", prod: "oa-p-" } as const;

  it("names each env's Worker with provision's prefix and origin", () => {
    for (const env of ENVS) {
      const e = cfg.env[env];
      // The prefix is the one provisioning uses for this env.
      expect(platformNames(env).broker).toBe(`${P[env]}auth-broker`);
      expect(e.name).toBe(`${P[env]}directory-broker`);
      expect(e.vars.DIRECTORY_ORIGIN).toBe(
        `https://directory.${HOSTED_DOMAINS[env].app}`,
      );
    }
  });
});
