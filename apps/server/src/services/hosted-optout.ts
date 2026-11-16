// The platform's opt-out list, hosted only (#2652). One platform-wide list
// (platform D1) keyed by an HMAC of the lowercased address; an install asks it
// before it emails an outside address and tells it when someone opts out.
// The contract (OA Platform, per OA Axe):
// - the install sends only HMAC(OPTOUT_HASH_KEY, address), never the address;
// - a token is minted per email and adding to the list needs it;
// - the check before sending fails closed: no answer, no email;
// - a self-hosted install never calls it.
// It runs over the existing signed gate (billing/transport.ts billingCall).
// The platform routes are not live yet, so it stays off until the platform
// sets OPTOUT_PLATFORM=on on the install (the way it enables any hosted route).
import { z } from "zod";
import { BillingUnavailableError, billingCall } from "../billing/transport.js";
import type { Env } from "../env.js";

export const OPTOUT_CHECK_PATH = "/optout/check";
export const OPTOUT_ADD_PATH = "/optout/add";

/** The platform's answer for one address: opted out or not, and the per-email token. */
export type OptoutAnswer = { optedOut: boolean; token: string };

/** The platform's list behind an interface, so the routes can land later and tests use a fake. */
export interface OptoutPlatform {
  /** Is each address HMAC opted out platform-wide? One answer per hash, in order, each with a freshly minted token. Throws when it can't answer. */
  check(env: Env, hashes: string[]): Promise<OptoutAnswer[]>;
  /** Adds an address HMAC to the list, with the token minted for that email. Throws when it can't. */
  add(env: Env, hash: string, token: string): Promise<void>;
}

const Answer = z.object({
  results: z.array(
    z.object({
      optedOut: z.boolean(),
      token: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    }),
  ),
});

/** Over the platform gate (signed POST, install id stamped by the gate). */
export const gateOptoutPlatform: OptoutPlatform = {
  async check(env, hashes) {
    const out = Answer.safeParse(
      await billingCall(env, OPTOUT_CHECK_PATH, { hashes }, Date.now()),
    );
    if (!out.success || out.data.results.length !== hashes.length)
      throw new BillingUnavailableError("bad_answer");
    return out.data.results;
  },
  async add(env, hash, token) {
    await billingCall(env, OPTOUT_ADD_PATH, { hash, token }, Date.now());
  },
};

/** What the code calls: the gate, or a fake in tests. */
export const optoutPlatform: { impl: OptoutPlatform } = {
  impl: gateOptoutPlatform,
};

/** Hosted installs the platform has switched on; self-host never. */
export const hostedOptoutOn = (env: Env): boolean =>
  env.HOSTED === "1" && env.OPTOUT_PLATFORM === "on";

/**
 * HMAC-SHA256(OPTOUT_HASH_KEY, lowercased address) as lowercase hex: the key
 * the platform's list uses. Null when the key is not set: the caller fails closed.
 */
export async function optoutHash(
  env: Env,
  email: string,
): Promise<string | null> {
  const key = env.OPTOUT_HASH_KEY?.trim();
  if (!key) return null;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    k,
    enc.encode(email.trim().toLowerCase()),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
