import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import rootPkg from "../../../package.json";
import { instanceVersion } from "../scripts/version-rule.js";
import { createPat } from "../src/auth/pat.js";
import { COMMIT, VERSION } from "../src/version.gen.js";
import { login } from "./helpers.js";
import { callWorker, connect } from "./mcp-helpers.js";

// Semver 2.0.0 with optional prerelease and build metadata.
const SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

describe("instanceVersion (the emitter's rule)", () => {
  it("a release: HEAD carries v<version>", () => {
    expect(
      instanceVersion({
        version: "0.3.0",
        tags: ["v0.3.0", "other"],
        sha: "abc1234",
      }),
    ).toBe("0.3.0");
  });

  it("not a release: no tag, another tag, or a tag without the v", () => {
    for (const tags of [[], ["v0.2.0"], ["0.3.0"], ["v0.3.0-rc"]])
      expect(instanceVersion({ version: "0.3.0", tags, sha: "abc1234" })).toBe(
        "0.3.0-dev+abc1234",
      );
  });

  it("no git: -dev without build metadata, never the bare release", () => {
    expect(instanceVersion({ version: "0.3.0", tags: null, sha: null })).toBe(
      "0.3.0-dev",
    );
    expect(
      instanceVersion({ version: "0.3.0", tags: ["v0.3.0"], sha: null }),
    ).toBe("0.3.0-dev");
  });

  it("every outcome is semver", () => {
    for (const v of ["0.3.0", "0.3.0-dev+abc1234", "0.3.0-dev"])
      expect(v).toMatch(SEMVER);
  });
});

describe("version.gen.ts", () => {
  it("is the root package.json version, with -dev+<COMMIT> off a release", () => {
    expect(VERSION).toMatch(SEMVER);
    expect([rootPkg.version, `${rootPkg.version}-dev+${COMMIT}`]).toContain(
      VERSION,
    );
  });
});

describe("version on the wire", () => {
  it("/healthz reports it", async () => {
    const r = await callWorker(new Request("https://app.localhost/healthz"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      plan: "free",
      version: VERSION,
      oauthStore: { mode: "kv", backfilled: false, kvWritesOffSince: null },
    });
  });

  it("MCP serverInfo carries it", async () => {
    const u = await login("version-mcp@x.com", "member");
    const client = await connect(
      (await createPat(env, u.userId, "version")).token,
    );
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: "open-artifacts",
        version: VERSION,
      });
    } finally {
      await client.close();
    }
  });
});
