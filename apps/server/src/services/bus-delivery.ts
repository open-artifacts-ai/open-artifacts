// The one seam between the server's notices (services/follows.ts) and a
// member's bus (#1292 here, #1291's BusHub there). The server decides who
// gets a notice, checks authz, rate-limits and renders it; delivery only
// carries it to one address in one member's bus.
//
// The hub side implements NoticeDelivery and installs it (installDelivery)
// where the Worker starts. Its contract:
// - Deliver `notice.text` to `notice.to` in `userId`'s bus, sent as
//   NOTICE_SENDER (a name no agent can take). Only the Worker calls this.
// - Coalescing: keep at most one waiting notice per (to, coalesceKey); a
//   newer one replaces the waiting one.
// - `notBefore` (ms): hold the notice until then (the server's one `changed`
//   per artifact per address per minute). Replaced like any waiting notice.
// - v1 message rules: an address with no live session drops the notice
//   ("dropped"); an offline machine's notice waits up to 1 h ("held").
// - Never throws for a delivery outcome; a thrown error counts as dropped.
//
// Until the hub lands, the default logs ids only (no address, no text).

import type { BusNotice } from "@oa/shared";
import type { Env } from "../env.js";

export type { BusNotice, NoticeKind } from "@oa/shared";

export type DeliveryOutcome = "delivered" | "held" | "dropped";

export interface NoticeDelivery {
  deliver(
    env: Env,
    userId: string,
    notice: BusNotice,
  ): Promise<DeliveryOutcome>;
}

/** Log-only: no bus yet. Ids and kind only. */
export const logOnlyDelivery: NoticeDelivery = {
  async deliver(env, _userId, n) {
    console.log(
      JSON.stringify({
        evt: "bus_notice",
        install: env.INSTALL_ID?.trim() || undefined,
        kind: n.kind,
        artifactId: n.artifactId,
        version: n.version,
        noticeId: n.id,
        outcome: "dropped",
        reason: "no_bus",
      }),
    );
    return "dropped";
  },
};

let current: NoticeDelivery = logOnlyDelivery;

/** Sets the delivery (the hub at start-up, a fake in tests); returns the previous one. */
export function installDelivery(d: NoticeDelivery): NoticeDelivery {
  const prev = current;
  current = d;
  return prev;
}

/** Delivers one notice to one address in `userId`'s bus. Never throws. */
export async function deliverNotice(
  env: Env,
  userId: string,
  notice: BusNotice,
): Promise<DeliveryOutcome> {
  try {
    return await current.deliver(env, userId, notice);
  } catch {
    return "dropped";
  }
}
