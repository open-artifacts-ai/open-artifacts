import type { IncomingMessage, ServerResponse } from "node:http";
import { expect } from "vitest";
import {
  GROUPS_HOOK,
  HELD_HOOK,
  SNOOZE_REASON,
  snoozeGroup,
} from "../src/snooze.ts";
import { json } from "./fake.ts";

// #1078: a fake install for the snooze owner path that keeps one hold, its
// snooze and the audit rows the way the server does. Shared by
// test/snooze.test.ts (the helper) and test/provisioning-fake.ts (P50's
// install). A handler for fakeServer.

const DAY = 86_400_000;

export type SnoozeOpts = {
  mode?: string;
  /** The org owner's address (default owner@<domain>). */
  ownerEmail?: (domain: string) => string;
  /** otp/latest's final no_code outcome (default: a code). */
  otpOutcome?: string;
  /** The fake's snooze leaves the hold counted (a server bug). */
  snoozeStillCounts?: boolean;
  /** The fake's cancel writes no audit row. */
  noCancelAudit?: boolean;
  /** The fake's release answers held:false but the hold still counts. */
  releaseLeaks?: boolean;
};

export interface SnoozeInstall {
  handle: (q: IncomingMessage, r: ServerResponse, body: string) => void;
  /** Each request as "METHOD path". */
  log: string[];
  /** The cookie header of each snooze or cancel. */
  cookies: string[];
  st: { held: boolean; snoozed: boolean; audit: unknown[] };
}

/** `domain()` is the install's TEST_DOMAIN; `installId` its /healthz id. */
export function snoozeInstall(
  domain: () => string,
  installId: string,
  o: SnoozeOpts = {},
): SnoozeInstall {
  const log: string[] = [];
  const cookies: string[] = [];
  const st = { held: false, snoozed: false, audit: [] as unknown[] };
  const gid = () => snoozeGroup(domain()).groupId;
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
      return json(r, 200, { ok: true, testHooks: true, installId });
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
        { email: `redline-admin@${domain()}`, role: "admin" },
        {
          email: (o.ownerEmail ?? ((d) => `owner@${d}`))(domain()),
          role: "owner",
        },
      ]);
    if (url === GROUPS_HOOK) return json(r, 200, { seeded: 1 });
    // The owner's code sign-in.
    if (url === "/auth/code/request")
      return json(r, 202, {}, { "set-cookie": ["oa_code=p; Path=/"] });
    if (url === "/__test/otp/latest")
      return o.otpOutcome
        ? json(r, 404, {
            error: {
              code: "not_found",
              message: "Not found",
              details: { reason: "no_code", outcome: o.otpOutcome },
            },
          })
        : json(r, 200, { code: "123456" });
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
  return { handle, log, cookies, st };
}
