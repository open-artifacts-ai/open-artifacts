import { z } from "zod";
import { isDeviceSecret, isUserCode, MACHINE_TOKEN_PREFIX } from "./ids.js";
import { LIMITS } from "./limits.js";
import { BAD_NS_CHARS } from "./namespace.js";
import { MachineLabelSchema } from "./refs.js";

const seg = (s: string): string => {
  if (s === "." || s === "..")
    throw new RangeError(`Unsafe path segment: ${JSON.stringify(s)}`);
  return encodeURIComponent(s);
};

/**
 * The instance routes the local client calls (design: Contracts, Local client
 * to instance). Everything is on the instance origin.
 */
export const BUS_ROUTES = {
  /**
   * The member's bus page (Machines and share notices). The client prints it
   * after sign-in as where to revoke this machine.
   */
  page: "/bus",
  /** `POST`, no auth: starts the device flow. Body `DeviceCodeRequestSchema`. */
  device: "/bus/device",
  /** `POST`, no auth: polls one device code. Body `DeviceTokenRequestSchema`. */
  deviceToken: "/bus/device/token",
  /** The page a signed-in member opens to approve a machine. */
  approve: (userCode: string): string => {
    if (!isUserCode(userCode))
      throw new RangeError("BUS_ROUTES.approve: invalid user code");
    return `/bus/approve/${seg(userCode)}`;
  },
  /** `GET` WebSocket upgrade, `Authorization: Bearer oa_machine_...`. */
  connect: "/bus/connect",
} as const;

const APPROVE_PREFIX = "/bus/approve/";

export const DeviceCodeRequestSchema = z.strictObject({
  machine_label: MachineLabelSchema.optional(),
});
export type DeviceCodeRequest = z.infer<typeof DeviceCodeRequestSchema>;

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/**
 * The schema cannot know the instance origin: the client must also check that
 * the URI's origin equals its configured instance URL before printing or
 * opening it (`verificationUriMatches`).
 */
const isSafeVerificationUri = (uri: string, userCode: string): boolean => {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.href !== uri) return false;
  if (
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" && isLoopback(u.hostname))
    )
  )
    return false;
  return u.pathname === `${APPROVE_PREFIX}${userCode}` && !u.search && !u.hash;
};

export const DeviceCodeResponseSchema = z
  .strictObject({
    device_code: z.string().refine(isDeviceSecret, "invalid device code"),
    user_code: z
      .string()
      .refine((s) => s.length === 9 && isUserCode(s), "invalid user code"),
    verification_uri: z.string().max(2048),
    expires_in: z.literal(LIMITS.deviceCodeTtlSec),
    interval: z.literal(LIMITS.devicePollIntervalSec),
  })
  .refine((v) => isSafeVerificationUri(v.verification_uri, v.user_code), {
    path: ["verification_uri"],
    message:
      "verification_uri must be https (http only for loopback) at /bus/approve/<user_code>",
  });
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

/** True when `uri` is on exactly `instanceOrigin` (scheme, host and port). */
export function verificationUriMatches(
  uri: string,
  instanceOrigin: string,
): boolean {
  try {
    return new URL(uri).origin === new URL(instanceOrigin).origin;
  } catch {
    return false;
  }
}

export const DeviceTokenRequestSchema = z.strictObject({
  device_code: z.string().refine(isDeviceSecret, "invalid device code"),
});
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequestSchema>;

const MachineTokenSchema = z
  .string()
  .regex(new RegExp(`^${MACHINE_TOKEN_PREFIX}[1-9A-HJ-NP-Za-km-z]{32}$`));

/**
 * `POST /bus/device/token`. Consumed, expired and unknown codes all read as
 * `expired`. Polling faster than `interval` answers HTTP 429 with
 * `Retry-After`; the client backs off and keeps polling.
 */
export const DeviceTokenResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    status: z.literal("approved"),
    machine_token: MachineTokenSchema,
  }),
  z.strictObject({ status: z.literal("denied") }),
  z.strictObject({ status: z.literal("expired") }),
]);
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;

/** The approval page's form body. */
export const ApprovalBodySchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  label: MachineLabelSchema.optional(),
});

const BAD_LABEL_CHARS = new RegExp(BAD_NS_CHARS.source, "gu");
const MAX_LABEL_UNITS = 2 * LIMITS.maxLabelChars;

/** Always returns a value that passes `MachineLabelSchema`. */
export const newMachineLabel = (hostname: string): string => {
  const clean = hostname
    .normalize("NFC")
    .replace(BAD_LABEL_CHARS, "")
    .normalize("NFC");
  let out = "";
  for (const ch of clean) {
    if (out.length + ch.length > MAX_LABEL_UNITS) break;
    out += ch;
  }
  return out.trim() || "machine";
};
