import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditCheck } from "../src/audit.ts";
import {
  type Cred,
  describeRes,
  fromContentApp,
  readBody,
  withCred,
} from "../src/http.ts";
import { guardProdClean } from "../src/prod.ts";
import { crossCheck, prepareSide, type Side } from "../src/refused.ts";
import { proof } from "../src/report.ts";
import {
  loadTargets,
  secretsOf,
  type Target,
  type Targets,
} from "../src/targets.ts";

// The guard and the harness's own live checks (P5 Task 1 and 2). Every case
// here is listed in live/manifest.json; Tasks 4-6 add theirs there too.

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
    // Staging with no prod probe throws ProdDirty("prod probe not configured").
    if ((await guardProdClean(T)) === "not-applicable")
      return proof(ctx, "not-applicable", "local mode");
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

    it(`${k}: the content host is served by the content app`, async () => {
      const t = T[k];
      const c = await fetch(`${t.content}/robots.txt`, { redirect: "manual" });
      const cb = await readBody(c);
      if (c.status !== 200 || !fromContentApp(c))
        throw new Error(`content /robots.txt: ${describeRes(c, cb)}`);
      // The app host must not look like the content app.
      const a = await fetch(`${t.app}/robots.txt`, { redirect: "manual" });
      const ab = await readBody(a);
      if (a.status !== 200 || fromContentApp(a))
        throw new Error(`app /robots.txt: ${describeRes(a, ab)}`);
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
      // The 404 must come from the content app itself, not anything else.
      if (res.status !== 404 || !fromContentApp(res))
        throw new Error(`content host hook: ${describeRes(res, body)}`);
    });

    it(`${k}: a hook call is audited`, async (ctx) => {
      const r = await auditCheck(T[k]);
      if (r.level === "unproven-live")
        return proof(ctx, "unproven-live", r.reason);
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
