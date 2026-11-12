import { z } from "zod";
import { ASK_ACTIONS, type AskAction } from "./comments.js";

// Passkey-confirmed picks (#2263).

/** The WebAuthn challenge TTL, in seconds. */
export const PASSKEY_CHALLENGE_TTL_S = 120;
/** A passkey may confirm only once it is this old (ms). */
export const PASSKEY_COOLING_MS = 24 * 60 * 60 * 1000;

export const PasskeySchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** When it may first confirm a pick or a change (createdAt + 24 h). */
  usableAt: z.string(),
  usable: z.boolean(),
});
export type Passkey = z.infer<typeof PasskeySchema>;

/** PublicKeyCredential.toJSON(): the browser's JSON form of a credential. */
export const PasskeyCredentialSchema = z.object({
  id: z.string().min(1).max(1400),
  rawId: z.string().min(1).max(1400),
  type: z.literal("public-key"),
  response: z.record(z.string(), z.unknown()),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  authenticatorAttachment: z.string().optional(),
});
export type PasskeyCredential = z.infer<typeof PasskeyCredentialSchema>;

export const PasskeyRegisterBodySchema = z.object({
  credential: PasskeyCredentialSchema,
  label: z.string().trim().min(1).max(60).optional(),
});
export type PasskeyRegisterBody = z.infer<typeof PasskeyRegisterBodySchema>;

export const PasskeyRemoveBodySchema = z
  .object({ assertion: z.unknown().optional() })
  .optional();

const ActionSwitches = z.object(
  Object.fromEntries(ASK_ACTIONS.map((a) => [a, z.boolean()])) as Record<
    AskAction,
    z.ZodBoolean
  >,
);

export const PasskeySettingsPutSchema = z.object({
  /** One switch per action: on asks for a passkey. `command` is locked on. */
  actions: ActionSwitches,
  /** Ask for a passkey on every pick, whatever it names. */
  everyPick: z.boolean(),
  /** Required when this turns any switch off. */
  assertion: z.unknown().optional(),
});
export type PasskeySettingsPut = z.infer<typeof PasskeySettingsPutSchema>;

export const PasskeySettingsSchema = z.object({
  actions: ActionSwitches,
  everyPick: z.boolean(),
  /** Switches that can not be turned off. */
  locked: z.array(z.enum(ASK_ACTIONS)),
  /** False: the switches show but can not be used ("Add a passkey to use these"). */
  hasPasskey: z.boolean(),
  /** True once a passkey is old enough to confirm. */
  hasUsablePasskey: z.boolean(),
});
export type PasskeySettings = z.infer<typeof PasskeySettingsSchema>;

/** The WebAuthn options JSON the server returns for a challenge. */
export type PasskeyChallenge = {
  options: Record<string, unknown>;
  expiresAt: string;
};
