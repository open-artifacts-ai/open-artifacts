import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cred } from "../src/http.ts";
import {
  GROUPS_HOOK,
  HELD_HOOK,
  NO_OWNER,
  NOT_GOOGLE,
  snoozeGroup,
  snoozeOwnerPath,
} from "../src/snooze.ts";
import { loadTargets, type Target } from "../src/targets.ts";
import { type Fake, fakeServer, json, secretDir } from "./fake.ts";
import { type SnoozeOpts, snoozeInstall } from "./snooze-fake.ts";

// #1078: the snooze case against a fake install that keeps one hold, its
// snooze and the audit rows the way the server does. Date is pinned.

const NOW = Date.UTC(2026, 10, 2, 12);
const PAT: Cred = { kind: "pat", token: "admin-pat" };
const OWNER: Cred = { kind: "cookie", name: "oa_session", value: "owner-c" };

const dirs: string[] = [];
const fakes: Fake[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fakes.splice(0)) await f.close();
});

/** rl-a on a fake install; `log` records each request as "METHOD path". */
async function install(o: SnoozeOpts = {}) {
  let domain = "";
  const { handle, log, st, cookies } = snoozeInstall(
    () => domain,
    "rl-a-id",
    o,
  );
  const f = await fakeServer(handle);
  fakes.push(f);
  const other = await fakeServer((_q, r) =>
    json(r, 200, { ok: true, testHooks: true, installId: "rl-b-id" }),
  );
  fakes.push(other);
  const s = secretDir({ k: "k".repeat(40) });
  dirs.push(s.dir);
  const tg = (name: string, x: Fake) => ({
    name,
    installId: "rl-a-id",
    app: x.origin,
    content: `http://${name}.content.localhost:1`,
    testDomain: `${name}.test`,
    hookKeyFile: s.path("k"),
  });
  const T = await loadTargets({
    REDLINE_TARGETS: JSON.stringify({
      mode: "local",
      a: tg("rl-a", f),
      b: { ...tg("rl-b", other), installId: "rl-b-id" },
    }),
  });
  domain = T.a.testDomain;
  log.splice(0);
  return { t: T.a as Target, log, st, cookies, origin: f.origin };
}

const asOwner = async () => OWNER;

describe("snoozeOwnerPath (#1078)", () => {
  it("passes: hold, snooze (off the count), cancel (back), audited; the hold is taken off; the owner makes the snooze calls", async () => {
    const x = await install();
    expect(await snoozeOwnerPath(x.t, PAT, { ownerCred: asOwner })).toEqual({
      level: "pass",
      target: "rl-a",
    });
    expect(x.st.held).toBe(false);
    expect(x.cookies).toEqual(["oa_session=owner-c", "oa_session=owner-c"]);
    const snooze = `/api/v1/directory/held/${snoozeGroup(x.t.testDomain).groupId}/snooze`;
    expect(x.log.filter((l) => l !== "GET /api/v1/me")).toEqual([
      "GET /api/v1/members",
      `POST ${GROUPS_HOOK}`,
      `POST ${HELD_HOOK}`,
      `POST ${HELD_HOOK}`,
      `POST ${snooze}`,
      `DELETE ${snooze}`,
      "GET /api/v1/audit?limit=100",
      `POST ${HELD_HOOK}`,
    ]);
    // The release is checked on the owner's count, not only the hook's answer.
    expect(x.log.at(-1)).toBe("GET /api/v1/me");
  });

  it("without ownerCred, the owner signs in by code (request, otp/latest, verify) and that session snoozes", async () => {
    const x = await install();
    expect((await snoozeOwnerPath(x.t, PAT)).level).toBe("pass");
    expect(x.log.slice(2, 5)).toEqual([
      "POST /auth/code/request",
      "POST /__test/otp/latest",
      "POST /auth/code/verify",
    ]);
    expect(x.cookies).toEqual([
      `${x.t.cookieName}=owner-s`,
      `${x.t.cookieName}=owner-s`,
    ]);
  });

  it("an owner the server sends no code (ineligible): unproven-live (NO_OWNER), nothing held", async () => {
    const x = await install({ otpOutcome: "ineligible" });
    expect(await snoozeOwnerPath(x.t, PAT)).toEqual({
      level: "unproven-live",
      reason: NO_OWNER,
    });
    expect(x.log).not.toContain(`POST ${HELD_HOOK}`);
  });

  it("any other final no_code outcome fails the case", async () => {
    const x = await install({ otpOutcome: "capped" });
    await expect(snoozeOwnerPath(x.t, PAT)).rejects.toThrow(
      /owner code: none arrived \(capped\)/,
    );
  });

  it("not on Google sync: unproven-live (NOT_GOOGLE), nothing held", async () => {
    const x = await install({ mode: "frozen" });
    expect(await snoozeOwnerPath(x.t, PAT, { ownerCred: asOwner })).toEqual({
      level: "unproven-live",
      reason: NOT_GOOGLE,
    });
    expect(x.log).toEqual(["GET /api/v1/me"]);
  });

  it("an owner outside the test domain: unproven-live (NO_OWNER), no sign-in, nothing held", async () => {
    const x = await install({ ownerEmail: () => "boss@corp.example" });
    const ownerCred = vi.fn(asOwner);
    expect(await snoozeOwnerPath(x.t, PAT, { ownerCred })).toEqual({
      level: "unproven-live",
      reason: NO_OWNER,
    });
    expect(ownerCred).not.toHaveBeenCalled();
    expect(x.log).toEqual(["GET /api/v1/me", "GET /api/v1/members"]);
    // A subdomain of the test domain isn't the test domain.
    const y = await install({ ownerEmail: (d) => `o@sub.${d}` });
    expect((await snoozeOwnerPath(y.t, PAT, { ownerCred })).level).toBe(
      "unproven-live",
    );
  });

  it("a snoozed hold that still counts fails the case, the hold is still taken off, and the message carries no address or host", async () => {
    const x = await install({ snoozeStillCounts: true });
    const err = await snoozeOwnerPath(x.t, PAT, { ownerCred: asOwner }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(
      "rl-a: heldSweeps is 1 after the snooze, want 0 (the snoozed hold still counts)",
    );
    expect(err?.message).not.toContain("@");
    expect(err?.message).not.toContain(x.origin);
    expect(x.st.held).toBe(false);
    expect(x.log.slice(-2)).toEqual([`POST ${HELD_HOOK}`, "GET /api/v1/me"]);
  });

  it("a release that answers held:false but still counts fails the case, with no address or host", async () => {
    const x = await install({ releaseLeaks: true });
    const err = await snoozeOwnerPath(x.t, PAT, { ownerCred: asOwner }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(
      "rl-a: heldSweeps is 1 after the release, want 0 (the hold still counts)",
    );
    expect(err?.message).not.toContain("@");
    expect(err?.message).not.toContain(x.origin);
  });

  it("no owner_cancel audit row fails the case", async () => {
    const x = await install({ noCancelAudit: true });
    await expect(
      snoozeOwnerPath(x.t, PAT, { ownerCred: asOwner }),
    ).rejects.toThrow(
      "rl-a audit: no directory.sweep.unsnoozed { why: owner_cancel } row for the suite group",
    );
    expect(x.st.held).toBe(false);
  });

  it("snoozeGroup: a fixed test- id per test domain, its email under that domain", () => {
    const g = snoozeGroup("Rl-A.test");
    expect(g).toEqual(snoozeGroup("rl-a.test"));
    expect(g.groupId).toMatch(/^test-redline-snooze-[0-9a-f]{8}$/);
    expect(g.email).toBe(`${g.groupId}@rl-a.test`);
  });
});
