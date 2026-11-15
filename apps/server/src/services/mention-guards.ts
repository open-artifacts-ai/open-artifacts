import { inDomains } from "@oa/auth-core";
import { authConfig } from "../auth/config.js";
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

/**
 * An outside member: a signed-in person (not the owner) whose address is
 * outside the instance's domains. With no domains configured nobody is outside.
 */
export async function isOutsideMember(
  env: Env,
  userId: string,
): Promise<boolean> {
  const domains = authConfig(env).domains;
  if (domains.length === 0) return false;
  const user = await getUser(env, userId);
  if (!user || user.role === "owner") return false;
  return !inDomains(domains, user.email.slice(user.email.lastIndexOf("@") + 1));
}

/**
 * Takes one slot for a mention of `receiverId`'s agent by `senderId`, under
 * both hourly caps (all or nothing). False when over a cap. `notice:` keys are
 * swept daily with the other notice counters.
 */
export async function takeMentionSlot(
  env: Env,
  senderId: string,
  receiverId: string,
  now = Date.now(),
): Promise<boolean> {
  const hour = new Date(now).toISOString().slice(0, 13);
  const caps: Cap[] = [
    [`notice:mention:from:${senderId}`, MENTIONS_PER_SENDER_PER_HOUR, hour],
    [`notice:mention:to:${receiverId}`, MENTIONS_PER_RECEIVER_PER_HOUR, hour],
  ];
  return (await takeAll(env, caps)) === -1;
}
