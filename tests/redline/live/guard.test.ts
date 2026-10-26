import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Cred, describeRes, readBody, withCred } from "../src/http.ts";
import { localD1Count } from "../src/local-pair.ts";
import { crossCheck, prepareSide, type Side } from "../src/refused.ts";
import { proof } from "../src/report.ts";
import {
  loadTargets,
  prodClean,
  secretsOf,
  type Target,
  type Targets,
} from "../src/targets.ts";

// The guard and the harness's own live checks (P5 Task 1 and 2). Tasks 4-6
// add their cases next to this file, each through crossCheck.

let T: Targets;
let A: Side;
let B: Side;

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  B = await prepareSide(T.b);
});

afterAll(async () => {
  for (const s of [A, B]) {
    if (!s) continue;
    await fetch(
      `${s.t.app}/api/v1/artifacts/${encodeURIComponent(s.markerId)}`,
      withCred(s.pat, { method: "DELETE" }),
    ).then((r) => r.body?.cancel());
  }
});

const me = (cred: Cred, t: Target) =>
  new Request(`${t.app}/api/v1/me`, withCred(cred));

describe("guard", () => {
  it("both targets report ok, testHooks: true and their own installId", async () => {
    // loadTargets checked it in beforeAll; this records it as a case.
    expect(T.a.installId).not.toBe(T.b.installId);
  });

  it("prod is clean (no test hooks on any prod install)", async (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "not-applicable", "local mode");
    if (!T.prod)
      return proof(ctx, "not-applicable", "prod inventory not configured");
    await prodClean(T.prod);
  });
});

describe("hooks", () => {
  for (const k of ["a", "b"] as const) {
    it(`${k}: a wrong hook key gets the 404`, async () => {
      const t = T[k];
      const res = await fetch(`${t.app}/__test/session`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${"x".repeat(40)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: `redline-admin@${t.testDomain}`,
          role: "admin",
        }),
      });
      const body = await readBody(res);
      if (res.status !== 404)
        throw new Error(`wrong key: ${describeRes(res, body)}`);
    });

    it(`${k}: the content host has no hooks`, async () => {
      const t = T[k];
      const res = await fetch(`${t.content}/__test/session`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${secretsOf(t).hookKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: `redline-admin@${t.testDomain}`,
          role: "admin",
        }),
      });
      const body = await readBody(res);
      if (res.status !== 404)
        throw new Error(`content host hook: ${describeRes(res, body)}`);
    });

    it(`${k}: a hook call is audited`, async (ctx) => {
      const t = T[k];
      // test_hook rows are kept out of GET /api/v1/audit, so only D1 shows them.
      if (!t.local)
        return proof(
          ctx,
          "unproven-live",
          "audit_events is readable only through D1",
        );
      const n = localD1Count(
        t.local,
        "select count(*) as n from audit_events where action = 'test_hook.session' and actor_kind = 'test_hook'",
      );
      expect(n).toBeGreaterThan(0);
    });
  }
});

describe("credentials (harness smoke)", () => {
  it("A's admin PAT at B: /api/v1/me", async () => {
    await crossCheck(me, { a: T.a, b: T.b, credA: A.pat, credB: B.pat });
  });

  it("A's session cookie at B: /api/v1/me", async () => {
    await crossCheck(me, { a: T.a, b: T.b, credA: A.cookie, credB: B.cookie });
  });

  it("A's admin PAT at B: the host's own marker artifact", async () => {
    const art = (cred: Cred, t: Target) =>
      new Request(
        `${t.app}/api/v1/artifacts/${encodeURIComponent(t === T.a ? A.markerId : B.markerId)}`,
        withCred(cred),
      );
    await crossCheck(art, { a: T.a, b: T.b, credA: A.pat, credB: B.pat });
  });
});
