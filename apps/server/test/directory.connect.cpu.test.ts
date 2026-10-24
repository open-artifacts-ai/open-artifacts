// P3 T12 directory connect CPU (Free plan: 10 ms per request). Wall-clock
// budgets run serially via vitest.cpu.config.ts (median of 7); absolute
// bounds are reports, asserted only under test:cpu:strict (see budget()).
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bindPage, planPage } from "../src/directory/binding.js";
import { seal } from "../src/directory/crypto.js";
import type { GoogleUser } from "../src/directory/google.js";
import { uniq } from "./auth-helpers.js";
import { budget, pairedMs, medianMs as time } from "./cpu-time.js";
import {
  begin,
  DIR_CID,
  directEnv,
  get,
  post,
  resetDirectory,
} from "./directory-helpers.js";
import { fakeDirectory } from "./fixtures/fake-directory.js";
import { login } from "./helpers.js";

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

describe("directory connect CPU (Free: 10 ms)", () => {
  it("GET R.directoryConnect fits the budget", async ({ annotate }) => {
    const e = directEnv();
    const owner = await login(uniq("cpu-dir-owner"), "owner");
    const ms = await time(async () => (await begin(e, owner.cookie)).r.status);
    await budget(annotate, "GET directory connect", ms, 4);
    expect(ms).toBeLessThan(50);
  });

  it("the callback (checks, seal, count) and the confirm (refresh, binding pass) fit the budget", async ({
    annotate,
  }) => {
    const e = directEnv();
    const g = fakeDirectory();
    const sub = `g-cpu-${crypto.randomUUID()}`;
    g.addUser({ id: sub, primaryEmail: uniq("cpu-super"), isAdmin: true });
    const owner = await login(uniq("cpu-dir-owner2"), "owner");
    const ms = await time(async () => {
      await resetDirectory();
      const b = await begin(e, owner.cookie);
      const code = g.issueCode(
        b.to?.searchParams.get("code_challenge") as string,
        { sub, aud: DIR_CID },
      );
      const r = await get(
        e,
        `${R.directoryCallback}?code=${code}&state=${encodeURIComponent(b.to?.searchParams.get("state") ?? "")}`,
        `${owner.cookie}; ${b.dirCookie}`,
      );
      expect(r.headers.get("location")).not.toContain("error");
    });
    await budget(annotate, "directory callback (consent + count)", ms, 10);
    expect(ms).toBeLessThan(200);

    // Confirm alone: the pending rows seeded, then POST R.directoryConfirm
    // (refresh at the fake Google, a small binding pass).
    const sealed = await seal(e, `rt-${sub}`);
    const binding = JSON.stringify({
      provider: "google",
      customerId: g.customerId,
      domain: "a.com",
      connectedBy: owner.userId,
      connectedAt: new Date().toISOString(),
    });
    const seed = () =>
      env.DB.prepare(
        "insert or replace into directory_state (key, value) values ('binding', ?), ('refresh', ?), ('connect.confirm', ?)",
      )
        .bind(
          binding,
          sealed,
          JSON.stringify({
            u: owner.userId,
            exp: Date.now() + 3600_000,
            count: 1,
            capped: false,
          }),
        )
        .run();
    // Seeding is the test's, not the request's: measured apart and taken off.
    const t = await pairedMs(seed, async () => {
      await seed();
      expect((await post(e, R.directoryConfirm, owner.cookie)).status).toBe(
        200,
      );
    });
    const confirmMs = Math.max(0, Math.round(t.delta));
    await budget(annotate, "directory confirm", confirmMs, 10);
    expect(confirmMs).toBeLessThan(200);
    g.restore();
  });

  let n = 0;
  const page = (): GoogleUser[] =>
    Array.from({ length: 500 }, () => ({
      id: `g-cpu-p-${n++}-${crypto.randomUUID()}`,
      primaryEmail: uniq("cpu-p"),
      suspended: false,
      deleted: false,
      isAdmin: false,
      customerId: "C0123",
    }));

  it("one 500-user page: the Worker-side plan fits the budget", async ({
    annotate,
  }) => {
    const p = page();
    const domains = new Set(["a.com"]);
    const ms = await time(async () => {
      const plan = planPage(domains, p);
      JSON.stringify(plan.all);
      JSON.stringify(plan.create);
    });
    await budget(annotate, "initial binding 500-user page plan", ms, 5);
    expect(ms).toBeLessThan(50);
  });

  it("one 500-user page bound through D1 (wall clock incl. local D1; report only)", async ({
    annotate,
  }) => {
    const e = directEnv();
    const ms = await time(() =>
      bindPage(e, page(), { tenant: "a.com", allowEmail: true }),
    );
    // D1 executes the set-based statements on its side in production; the
    // local wall clock includes it, so this is reported, not budgeted.
    await annotate(`initial binding 500-user page incl. D1: ${ms} ms`);
    expect(ms).toBeLessThan(2000);
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from identities where subject like 'g-cpu-p-%'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(500 * 8);
  });
});
