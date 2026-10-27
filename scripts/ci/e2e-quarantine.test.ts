import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadQuarantine,
  parseQuarantine,
  type Quarantined,
  quarantineGrep,
  suiteOf,
} from "../../apps/dashboard/e2e/quarantine.ts";
import { root } from "./stubs.ts";

const entry = (o: Partial<Quarantined> = {}): Quarantined => ({
  file: "nav.spec.ts",
  title: "sidebar B metrics at 1280px",
  owner: "Platform",
  since: "2026-10-27",
  reason: "flaky under load",
  ...o,
});
const parse = (tests: unknown[]) => parseQuarantine(JSON.stringify({ tests }));

describe("quarantine.json", () => {
  it("the committed list is valid, and every entry names a test that exists", () => {
    for (const q of loadQuarantine()) {
      const file = join(root, "apps/dashboard/e2e", q.file);
      expect(existsSync(file), q.file).toBe(true);
      const last = q.title.split(" › ").at(-1) as string;
      expect(readFileSync(file, "utf8"), `${q.file} › ${q.title}`).toContain(
        last,
      );
    }
  });
  it("needs an owner, a date, a reason and a spec under e2e/; refuses duplicates", () => {
    expect(parse([entry()])).toHaveLength(1);
    expect(() => parse([entry({ owner: " " })])).toThrow(/owner is required/);
    expect(() => parse([entry({ since: "27/10/2026" })])).toThrow(/YYYY-MM-DD/);
    expect(() => parse([entry({ reason: "" })])).toThrow(/reason is required/);
    expect(() => parse([entry({ file: "../x.spec.ts" })])).toThrow(
      /spec under e2e/,
    );
    expect(() => parse([entry(), entry()])).toThrow(/duplicate/);
    expect(() => parseQuarantine("{}")).toThrow(/must be an array/);
  });
});

describe("quarantineGrep", () => {
  // The strings Playwright matches grep against: "<project> <file under
  // testDir> <describe titles> <title> <tags>" (checked against --list).
  it("matches exactly the quarantined test, in its own suite", () => {
    const re = quarantineGrep([entry()], "mock") as RegExp;
    expect(re.test("nav.spec.ts sidebar B metrics at 1280px")).toBe(true);
    expect(re.test("nav.spec.ts sidebar B metrics at 1280px @slow")).toBe(true);
    expect(re.test("nav.spec.ts sidebar B metrics at 1280px wide")).toBe(false);
    expect(re.test("other-nav.spec.ts sidebar B metrics at 1280px")).toBe(
      false,
    );
    expect(quarantineGrep([entry()], "real")).toBeUndefined();
  });
  it("real suite: drops the real/ prefix and matches any project; describes join by spaces", () => {
    const q = entry({
      file: "real/consent.spec.ts",
      title: "outer › cross-site (consent) decision is rejected?",
    });
    expect(suiteOf(q)).toBe("real");
    const re = quarantineGrep([q], "real") as RegExp;
    for (const p of ["chromium", "webkit"])
      expect(
        re.test(
          `${p} consent.spec.ts outer cross-site (consent) decision is rejected?`,
        ),
      ).toBe(true);
    // regex characters in titles are literal
    expect(
      re.test(
        "chromium consent.spec.ts outer cross-site consent decision is rejected",
      ),
    ).toBe(false);
  });
  it("the gating runs skip quarantined tests; OA_E2E_QUARANTINE=only runs just them", async () => {
    const { quarantineOptions } = await import(
      "../../apps/dashboard/e2e/quarantine.ts"
    );
    const empty = loadQuarantine().length === 0;
    if (empty) {
      expect(quarantineOptions("mock", {})).toEqual({});
      // nothing quarantined: a grep that matches nothing at all
      const only = quarantineOptions("mock", { OA_E2E_QUARANTINE: "only" });
      expect(only.grep?.test("nav.spec.ts anything")).toBe(false);
    }
  });
});
