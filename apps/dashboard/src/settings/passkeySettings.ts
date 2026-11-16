/**
 * PROVISIONAL (#2661): the passkey settings, in the shape OA Comments pinned
 * on #2661 (`{ highStakes, everyAnswer, ownRule }`), until @oa/shared and the
 * server have it. The only place Settings reads or writes R.passkeySettings.
 */
import { R } from "@oa/shared";
import { z } from "zod";
import { api } from "../api/client";
import { getAssertion } from "../auth/webauthn";

/** The longest own rule the server accepts. */
export const OWN_RULE_MAX = 500;

export const PasskeySettingsSchema = z.object({
  /** Ask for the passkey when a decision is marked high stakes. */
  highStakes: z.boolean(),
  /** Ask on every answer, marked or not. */
  everyAnswer: z.boolean(),
  /** "Also treat as high stakes:", in the person's own words; their agents get it. */
  ownRule: z.string().max(OWN_RULE_MAX),
  /** Absent: read from the passkey list instead. */
  hasPasskey: z.boolean().optional(),
});
export type PasskeySettings = z.infer<typeof PasskeySettingsSchema>;
/** PATCH R.passkeySettings and POST R.passkeySettingsChallenge: the full new state. */
export type PasskeySettingsBody = Pick<
  PasskeySettings,
  "highStakes" | "everyAnswer" | "ownRule"
>;

const ChallengeSchema = z.object({
  options: z.record(z.string(), z.unknown()),
  expiresAt: z.string(),
});

export const getPasskeySettings = (signal?: AbortSignal) =>
  api.get(R.passkeySettings, PasskeySettingsSchema, signal);

/** Turning a switch off, or changing the rule, needs the passkey; turning one on doesn't. */
export const needsPasskey = (
  from: PasskeySettingsBody,
  to: PasskeySettingsBody,
) =>
  (from.highStakes && !to.highStakes) ||
  (from.everyAnswer && !to.everyAnswer) ||
  from.ownRule !== to.ownRule;

/**
 * Save `to`. When it needs the passkey: a challenge bound to the same body,
 * the prompt (`onPrompt` first), then the PATCH with the assertion.
 */
export async function savePasskeySettings(
  from: PasskeySettingsBody,
  to: PasskeySettingsBody,
  onPrompt?: () => void,
): Promise<PasskeySettings> {
  const body: PasskeySettingsBody = {
    highStakes: to.highStakes,
    everyAnswer: to.everyAnswer,
    ownRule: to.ownRule,
  };
  if (!needsPasskey(from, body))
    return api.send("PATCH", R.passkeySettings, body, PasskeySettingsSchema);
  onPrompt?.();
  const ch = await api.send(
    "POST",
    R.passkeySettingsChallenge,
    body,
    ChallengeSchema,
  );
  const assertion = await getAssertion(ch.options);
  return api.send(
    "PATCH",
    R.passkeySettings,
    { ...body, assertion },
    PasskeySettingsSchema,
  );
}
