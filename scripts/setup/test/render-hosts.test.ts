import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderConfig } from "../src/steps/resources.ts";

// The server answers APP_HOST and CONTENT_HOST only (P1 Task 6b), with no
// any-host fallback, so setup must never render a config without both.
const TEMPLATE = readFileSync(
  join(import.meta.dirname, "../../../apps/server/wrangler.template.jsonc"),
  "utf8",
);
const VARS = {
  WORKER_NAME: "w",
  APP_HOST: "a.example.com",
  CONTENT_HOST: "c.example.com",
  OWNER_EMAIL: "o@example.com",
  D1_NAME: "d",
  D1_ID: "1",
  R2_BUCKET: "r",
  KV_ID: "k",
  CF_ACCOUNT_ID: "acc",
  ACCESS_TEAM_DOMAIN: "t",
  ACCESS_CLIENT_ID: "i",
};

describe("rendered config names both hosts", () => {
  it("renders APP_HOST and CONTENT_HOST", () => {
    const c = JSON.parse(renderConfig(TEMPLATE, VARS));
    expect(c.vars.APP_HOST).toBe("a.example.com");
    expect(c.vars.CONTENT_HOST).toBe("c.example.com");
  });

  it("refuses an empty or blank APP_HOST or CONTENT_HOST", () => {
    for (const k of ["APP_HOST", "CONTENT_HOST"])
      for (const v of ["", " "])
        expect(() => renderConfig(TEMPLATE, { ...VARS, [k]: v })).toThrow(
          new RegExp(k),
        );
  });

  it("refuses the same host for both, after the server's normalization", () => {
    for (const CONTENT_HOST of [
      "a.example.com",
      "A.Example.com",
      "a.example.com.",
      "a.example.com:443",
      " a.example.com ",
    ])
      expect(() => renderConfig(TEMPLATE, { ...VARS, CONTENT_HOST })).toThrow(
        /APP_HOST and CONTENT_HOST/,
      );
  });

  it("refuses an unrendered placeholder as a host", () => {
    for (const k of ["APP_HOST", "CONTENT_HOST"])
      expect(() =>
        renderConfig(TEMPLATE, { ...VARS, [k]: `{{${k}}}` }),
      ).toThrow(new RegExp(k));
  });
});
