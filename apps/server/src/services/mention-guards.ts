import { inDomains } from "@oa/auth-core";
import { callerOf, capOfCaller } from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { isGuestRole, isInstanceOwner } from "../auth/policy.js";
import { type Cap, refundAll, takeAll } from "../email/send.js";
import type { Env } from "../env.js";
import { getUser } from "./users.js";

// #2559: three guards on waking another person's agent from a comment.

/** Mentions (or asks) of other people's agents one person may send per hour. */
export const MENTIONS_PER_SENDER_PER_HOUR = 10;
/** Mentions (or asks) of one person's agents, from anyone, per hour. */
export const MENTIONS_PER_RECEIVER_PER_HOUR = 40;

/** Refusal for an outside member who names another person's agent. */
export const OWN_AGENTS_ONLY = "You can mention only your own agents here.";
/** Non-fatal notice on the response when a mention is over the limit. */
export const TOO_MANY_MENTIONS =
  "That's a lot of mentions. Try again in a few minutes.";

/** The guest role, or a guest cap (not a restricted or plan cap). */
const guestLike = (user: Awaited<ReturnType<typeof getUser>>): boolean =>
  !!user && (isGuestRole(user.role) || capOfCaller(callerOf(user)) === "guest");

/**
 * A guest: the guest role, or a guest cap on the person. Decided without
 * AUTH_DOMAINS. A full member's guest-capped token is not covered here, which
 * is fine: a token's comment wakes nobody else (#2564 guard 3).
 */
export async function isGuestMember(
  env: Env,
  userId: string,
): Promise<boolean> {
  return guestLike(await getUser(env, userId));
}

/**
 * Outside for agent wake-ups: a guest always, whatever AUTH_DOMAINS says; or
 * a signed-in person (not the owner) whose address is outside the instance's
 * domains. With no domains configured only guests are outside.
 */
export async function isOutsideMember(
  env: Env,
  userId: string,
): Promise<boolean> {
  const user = await getUser(env, userId);
  if (!user) return false;
  if (guestLike(user)) return true;
  const domains = authConfig(env).domains;
  if (domains.length === 0 || isInstanceOwner(user)) return false;
  return !inDomains(domains, user.email.slice(user.email.lastIndexOf("@") + 1));
}

/** #2577: one delivery to a person's agents after an allow: a slot of the receiver's hourly limit. False: over it. */
export async function takeReceiverSlot(
  env: Env,
  receiverId: string,
  now = Date.now(),
): Promise<boolean> {
  const hour = new Date(now).toISOString().slice(0, 13);
  const to: Cap = [
    `notice:mention:to:${receiverId}`,
    MENTIONS_PER_RECEIVER_PER_HOUR,
    hour,
  ];
  return (await takeAll(env, [to])) === -1;
}

/** #2577: gives back a slot takeReceiverSlot took when nothing was delivered. */
export async function giveBackReceiverSlot(
  env: Env,
  receiverId: string,
  now = Date.now(),
): Promise<void> {
  const hour = new Date(now).toISOString().slice(0, 13);
  await refundAll(env, [
    [`notice:mention:to:${receiverId}`, MENTIONS_PER_RECEIVER_PER_HOUR, hour],
  ]);
}

/**
 * One comment's draw on the mention limits. The sender's slot is taken once
 * per comment, on its first wake of another person's agent; the receiver's
 * slot is taken per wake, per receiving person. Over a cap: false, and the
 * comment's later wakes see the same sender refusal. `notice:` keys are swept
 * daily with the other notice counters.
 */
export class MentionGate {
  private sent = false;
  private blocked = false;
  constructor(
    private env: Env,
    private senderId: string,
    private now = Date.now(),
  ) {}

  /**
   * #2577: the sender's slot alone, for a request that is held (nothing is
   * woken, so no receiver slot). Once per comment, like take(). False: the
   * sender is over their hourly limit, so nothing is held either.
   */
  async takeSender(): Promise<boolean> {
    if (this.blocked) return false;
    if (this.sent) return true;
    const hour = new Date(this.now).toISOString().slice(0, 13);
    const from: Cap = [
      `notice:mention:from:${this.senderId}`,
      MENTIONS_PER_SENDER_PER_HOUR,
      hour,
    ];
    const full = await takeAll(this.env, [from]);
    if (full === -1) this.sent = true;
    else this.blocked = true;
    return full === -1;
  }

  async take(receiverId: string): Promise<boolean> {
    if (this.blocked) return false;
    const hour = new Date(this.now).toISOString().slice(0, 13);
    const to: Cap = [
      `notice:mention:to:${receiverId}`,
      MENTIONS_PER_RECEIVER_PER_HOUR,
      hour,
    ];
    const from: Cap = [
      `notice:mention:from:${this.senderId}`,
      MENTIONS_PER_SENDER_PER_HOUR,
      hour,
    ];
    if (this.sent) return (await takeAll(this.env, [to])) === -1;
    // All or nothing: a full sender cap gives the receiver's slot back.
    const full = await takeAll(this.env, [to, from]);
    if (full === -1) this.sent = true;
    else if (full === 1) this.blocked = true;
    return full === -1;
  }
}
