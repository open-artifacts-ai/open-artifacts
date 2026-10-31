import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OidcError } from "@oa/gh-oidc";
import { describe, expect, it } from "vitest";
import { pinsFromEnv } from "../src/auth.ts";
import defaultWorker, { makeWorker } from "../src/index.ts";
import {
  BEARER,
  JWT,
  MONITOR,
  makeEnv,
  REDLINE,
  REPO,
  req,
  VARS,
  worker,
} from "./support.ts";

const PATHS = ["/installs", "/hosts", "/hosts?host=a.test", "/health"];

async function expectFixed(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.text()).toBe(JSON.stringify({ error }));
}

describe("production wiring", () => {
  it("the default export uses @oa/gh-oidc's verify, which fails closed: any bearer is 401", async () => {
    for (const p of [...PATHS, "/prodclean", "/nope"])
      await expectFixed(
        await defaultWorker.fetch(
          req(p, { method: p === "/prodclean" ? "POST" : "GET" }, BEARER),
          makeEnv(),
        ),
        401,
        "unauthorized",
      );
  });
});

describe("bearer", () => {
  const cases: [string, string | undefined][] = [
    ["no header", undefined],
    ["a wrong scheme", `Basic ${JWT}`],
    ["a bare token", JWT],
    ["an empty bearer", "Bearer "],
    ["a bearer with a space", `Bearer ${JWT} x`],
    ["a wrong token", "Bearer x.y.z"],
    ["an oversized bearer", `Bearer ${"a".repeat(8193)}`],
  ];
  for (const [what, auth] of cases)
    it(`${what} -> fixed 401 on every path`, async () => {
      const { w } = worker();
      for (const p of [...PATHS, "/nope"])
        await expectFixed(
          await w.fetch(req(p, {}, auth), makeEnv()),
          401,
          "unauthorized",
        );
      await expectFixed(
        await w.fetch(req("/prodclean", { method: "POST" }, auth), makeEnv()),
        401,
        "unauthorized",
      );
    });

  it("an OidcError's code never reaches the body", async () => {
    const w = makeWorker({
      verify: async () => {
        throw new OidcError("bad_sig");
      },
      now: () => 0,
    });
    const res = await w.fetch(req("/installs", {}, BEARER), makeEnv());
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toBe('{"error":"unauthorized"}');
    expect(text).not.toContain("bad_sig");
    expect(text).not.toContain("oidc");
  });

  it("a non-Oidc throw (a JWKS fetch failing) is the same 401", async () => {
    const w = makeWorker({
      verify: async () => {
        throw new TypeError("fetch failed: jwks.example");
      },
      now: () => 0,
    });
    const res = await w.fetch(req("/health", {}, BEARER), makeEnv());
    await expectFixed(res, 401, "unauthorized");
  });

  it("verify gets the bearer and exactly the parsed pins", async () => {
    const { w, calls } = worker();
    await w.fetch(req("/health", {}, BEARER), makeEnv());
    expect(calls).toEqual([
      {
        jwt: JWT,
        pins: {
          audience: VARS.OIDC_AUDIENCE,
          repository: REPO,
          repositoryId: VARS.OIDC_REPOSITORY_ID,
          jobWorkflowRefs: [REDLINE, MONITOR],
          environment: "redline-staging",
        },
      },
    ]);
  });
});

describe("vars fail closed", () => {
  const KEYS = Object.keys(VARS) as (keyof typeof VARS)[];
  for (const k of KEYS)
    for (const v of [undefined, "", "   "])
      it(`${k} ${v === undefined ? "missing" : JSON.stringify(v)} -> 503, verify never called`, async () => {
        const { w, calls } = worker();
        const env = makeEnv({ [k]: v });
        for (const p of PATHS)
          await expectFixed(
            await w.fetch(req(p, {}, BEARER), env),
            503,
            "unavailable",
          );
        // Before the header is read: no bearer is still 503.
        await expectFixed(
          await w.fetch(req("/installs"), env),
          503,
          "unavailable",
        );
        expect(calls).toEqual([]);
      });

  it("a workflow ref list of only commas is empty -> 503", async () => {
    const { w, calls } = worker();
    const env = makeEnv({ OIDC_JOB_WORKFLOW_REFS: " , ,," });
    await expectFixed(
      await w.fetch(req("/installs", {}, BEARER), env),
      503,
      "unavailable",
    );
    expect(calls).toEqual([]);
  });

  it("pinsFromEnv trims and drops empty refs", () => {
    expect(
      pinsFromEnv({ ...VARS, OIDC_JOB_WORKFLOW_REFS: ` ${MONITOR} ,, ` })
        ?.jobWorkflowRefs,
    ).toEqual([MONITOR]);
    expect(pinsFromEnv({})).toBeNull();
  });
});

describe("routing after auth", () => {
  it("an authenticated unknown path is a plain 404", async () => {
    const { w } = worker();
    for (const p of [
      "/",
      "/installs/x",
      "/hostsx",
      "/__proto__",
      "/toString",
    ]) {
      const res = await w.fetch(req(p, {}, BEARER), makeEnv());
      expect(res.status, p).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
  });

  it("a wrong method on a known path is 405 with Allow", async () => {
    const { w } = worker();
    for (const [p, m, allow] of [
      ["/installs", "POST", "GET"],
      ["/hosts", "DELETE", "GET"],
      ["/health", "PUT", "GET"],
      ["/prodclean", "GET", "POST"],
    ] as const) {
      const res = await w.fetch(req(p, { method: m }, BEARER), makeEnv());
      expect(res.status, `${m} ${p}`).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
    }
  });
});

describe("INVENTORY_KEY is gone", () => {
  it("no INVENTORY_KEY, keyMatches or sha256 anywhere in apps/inventory", () => {
    const root = new URL("..", import.meta.url).pathname;
    const self = new URL(import.meta.url).pathname;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        if (f === "node_modules") return [];
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const f of walk(root)) {
      if (f === self) continue;
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/INVENTORY_KEY|keyMatches|sha256\(/);
    }
  });
});
