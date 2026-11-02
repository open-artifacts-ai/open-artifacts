import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cred } from "../src/http.ts";
import {
  GROUPS_HOOK,
  HELD_HOOK,
  NO_OWNER,
  NOT_GOOGLE,
  SNOOZE_REASON,
  snoozeGroup,
  snoozeOwnerPath,
} from "../src/snooze.ts";
import { loadTargets, type Target } from "../src/targets.ts";
import { type Fake, fakeServer, json, secretDir } from "./fake.ts";

// #1078: the snooze case against a fake install that keeps one hold, its
// snooze and the audit rows the way the server does. Date is pinned.

const NOW = Date.UTC(2026, 10, 2, 12);
const DAY = 86_400_000;
const PAT: Cred = { kind: "pat", token: "admin-pat" };
const OWNER: Cred = { kind: "cookie", name: "oa_session", value: "owner-c" };

type Opts = {
  mode?: string;
  ownerEmail?: (domain: string) => string;
  /** The fake's snooze leaves the hold counted (a server bug). */
  snoozeStillCounts?: boolean;
  /** The fake's cancel writes no audit row. */
  noCancelAudit?: boolean;
  /** The fake's release answers held:false but the hold still counts. */
  releaseLeaks?: boolean;
};

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
async function install(o: Opts = {}) {
  const log: string[] = [];
  const cookies: string[] = [];
  const st = {
    held: false,
    snoozed: false,
    audit: [] as unknown[],
  };
  let domain = "";
  const gid = () => snoozeGroup(domain).groupId;
  const status = () => ({
    held: st.held
      ? [
          {
            groupId: gid(),
            snoozedUntil: st.snoozed
              ? new Date(Date.now() + 30 * DAY).toISOString()
              : null,
          },
        ]
      : [],
  });
  const row = (action: string, detail: unknown) => ({
    id: `e${st.audit.length}`,
    at: new Date(Date.now()).toISOString(),
    action,
    target: { type: "group", id: gid() },
    detail,
  });
  const handle = (q: IncomingMessage, r: ServerResponse, body: string) => {
    const url = q.url ?? "";
    const method = q.method ?? "GET";
    log.push(`${method} ${url}`);
    if (url === "/healthz")
      return json(r, 200, { ok: true, testHooks: true, installId: "rl-a-id" });
    if (url === "/api/v1/me")
      return json(r, 200, {
        user: { email: "x" },
        instance: {
          directory: {
            mode: o.mode ?? "google",
            heldSweeps: st.held && (!st.snoozed || o.snoozeStillCounts) ? 1 : 0,
          },
        },
      });
    if (url === "/api/v1/members")
      return json(r, 200, [
        { email: `redline-admin@${domain}`, role: "admin" },
        {
          email: (o.ownerEmail ?? ((d) => `owner@${d}`))(domain),
          role: "owner",
        },
      ]);
    if (url === GROUPS_HOOK) return json(r, 200, { seeded: 1 });
    // The owner's code sign-in.
    if (url === "/auth/code/request")
      return json(r, 202, {}, { "set-cookie": ["oa_code=p; Path=/"] });
    if (url === "/__test/otp/latest") return json(r, 200, { code: "123456" });
    if (url === "/auth/code/verify") {
      expect(JSON.parse(body)).toEqual({ code: "123456" });
      expect(q.headers.cookie).toBe("oa_code=p");
      return json(
        r,
        200,
        {},
        {
          "set-cookie": [
            "oa_session=owner-s; Path=/",
            "__Host-oa_session=owner-s; Path=/",
          ],
        },
      );
    }
    if (url === HELD_HOOK) {
      const b = JSON.parse(body) as { held: boolean; groupId: string };
      expect(b.groupId).toBe(gid());
      const leak = !b.held && o.releaseLeaks && st.held;
      st.held = b.held || Boolean(leak);
      if (!b.held) st.snoozed = false;
      return json(r, 200, { held: b.held });
    }
    const snooze = `/api/v1/directory/held/${gid()}/snooze`;
    if (url === snooze) {
      cookies.push(String(q.headers.cookie));
      if (method === "POST") {
        expect(JSON.parse(body)).toEqual({ reason: SNOOZE_REASON });
        st.snoozed = true;
        st.audit.unshift(row("directory.sweep.snoozed", { until: "x" }));
      } else {
        st.snoozed = false;
        if (!o.noCancelAudit)
          st.audit.unshift(
            row("directory.sweep.unsnoozed", { why: "owner_cancel" }),
          );
      }
      return json(r, 200, status());
    }
    if (url.startsWith("/api/v1/audit"))
      return json(r, 200, { items: st.audit, nextCursor: null });
    r.writeHead(404).end();
  };
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
