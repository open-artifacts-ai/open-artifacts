import type { Member } from "@oa/shared";
import { callerOf, capOfCaller, planOfMember } from "../auth/authz.js";
import { planError } from "../billing/plan.js";
import { ApiError } from "../http/errors.js";

// #1299: the billing gate on the bus's configuration surfaces. Under a plan
// cap (hosted billing's lock on a non-owner) a member's
// existing machines keep connecting, sending and receiving, and their
// existing share notices keep delivering, but nothing new is configured:
// approving a machine, confirming a role or a link, proposing either, and
// saving share notices all refuse. Revoking and every read stay open.
// It is the existing plan cap (capOfCaller), so it applies to non-owners
// only and only where billing is active: self-host carries no plan, so no
// cap, and nothing here changes.
// A suspension carries the plan cap too, so it is refused here as well; but it
// blocks MORE than this set: canConnect is false for a suspended member, so
// their machines are refused at connect (401) and their share notices stop.

/** The plan refusal for `user`'s bus configuration, or null when it may proceed. */
export function busConfigRefusal(user: Member): ApiError | null {
  if (capOfCaller(callerOf(user)) !== "plan") return null;
  const lock = planOfMember(user)?.lock;
  // A plan cap always carries its lock; fail closed if one ever does not.
  return lock
    ? planError(lock)
    : new ApiError(
        "plan_read_only",
        "Team features are read-only until the plan is paid; nothing was deleted",
      );
}

/** Throws the plan refusal (the REST writes' error) when `user` is under a plan cap. */
export function busConfigCap(user: Member): void {
  const e = busConfigRefusal(user);
  if (e) throw e;
}
