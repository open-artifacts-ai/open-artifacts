// #1252: T19's targets accept the red-line local pair (plain http on
// *.localhost) only off CI. CI can never point T19 at plain http, and a local
// target set can't name a staging or prod host.
import { describe, expect, it } from "vitest";
import { LOCAL_COOKIE, rlA, STAGING_COOKIE } from "../e2e/staging/targets";

const targets = (mode: string, app: string) =>
  JSON.stringify({
    mode,
    a: {
      name: "rl-a",
      installId: "ilocal000001",
      app,
      testDomain: "oa-redline-a.fyi",
      hookKeyFile: "/tmp/hook-key",
    },
  });
const LOCAL = "http://rl-a.app.localhost:41234";
const STAGING = "https://rl-a.open-artifacts-staging.app";

describe("T19 targets", () => {
  it("staging over https, as CI runs it", () => {
    const a = rlA({ REDLINE_TARGETS: targets("staging", STAGING), CI: "true" });
    expect(a.app).toBe(STAGING);
    expect(a.cookieName).toBe(STAGING_COOKIE);
  });

  it("local: the pair's http://rl-a.app.localhost:<port>, off CI", () => {
    const a = rlA({ REDLINE_TARGETS: targets("local", LOCAL) });
    expect(a.app).toBe(LOCAL);
    expect(a.cookieName).toBe(LOCAL_COOKIE);
    expect(a.hookKeyFile).toBe("/tmp/hook-key");
  });

  it("local is refused whenever CI is set", () => {
    for (const CI of ["true", "1"])
      expect(() =>
        rlA({ REDLINE_TARGETS: targets("local", LOCAL), CI }),
      ).toThrow(
        "T19 targets: REDLINE_TARGETS.mode local is refused when CI is set",
      );
  });

  it("local refuses a staging or prod host, https or not", () => {
    for (const app of [
      STAGING,
      "http://rl-a.open-artifacts-staging.app",
      "https://leo.open-artifacts.app",
      "http://rl-a.app.localhost",
      "http://localhost:41234",
    ])
      expect(() => rlA({ REDLINE_TARGETS: targets("local", app) })).toThrow(
        "a.app must be a bare http://<name>.localhost:<port> origin",
      );
  });

  it("staging refuses plain http, a localhost one included", () => {
    expect(() =>
      rlA({ REDLINE_TARGETS: targets("staging", LOCAL), CI: "true" }),
    ).toThrow("a.app must be a bare https origin");
  });

  it("any other mode is refused, prod included", () => {
    for (const mode of ["prod", "Local", ""])
      expect(() => rlA({ REDLINE_TARGETS: targets(mode, STAGING) })).toThrow(
        "REDLINE_TARGETS.mode must be staging",
      );
  });
});
