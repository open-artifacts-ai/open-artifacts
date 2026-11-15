import { inDomains } from "@oa/auth-core";
import { callerOf, capOfCaller } from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { capsReads, isGuestRole, isInstanceOwner } from "../auth/policy.js";
import { type Cap, takeAll } from "../email/send.js";
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

/** A guest: the guest role, or a guest cap on the person. Decided without AUTH_DOMAINS. */
export async function isGuestMember(
  env: Env,
  userId: string,
): Promise<boolean> {
  const user = await getUser(env, userId);
  return (
    !!user && (isGuestRole(user.role) || capsReads(capOfCaller(callerOf(user))))
  );
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
  if (isGuestRole(user.role) || capsReads(capOfCaller(callerOf(user))))
    return true;
  const domains = authConfig(env).domains;
  if (domains.length === 0 || isInstanceOwner(user)) return false;
  return !inDomains(domains, user.email.slice(user.email.lastIndexOf("@") + 1));
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
