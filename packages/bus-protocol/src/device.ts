import { z } from "zod";
import { isDeviceSecret, isUserCode, MACHINE_TOKEN_PREFIX } from "./ids.ts";
import { LIMITS } from "./limits.ts";
import { BAD_NS_CHARS } from "./namespace.ts";
import { MachineLabelSchema } from "./refs.ts";

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
  /**
   * The page a signed-in member opens to approve a machine, and types the
   * code their terminal shows into (RFC 8628 section 5.4). The code is never
   * in this URL: a link that carried it would be one click from approving
   * someone else's machine.
   */
  approve: "/bus/approve",
  /** `GET` WebSocket upgrade, `Authorization: Bearer oa_machine_...`. */
  connect: "/bus/connect",
} as const;

export const DeviceCodeRequestSchema = z.strictObject({
  machine_label: MachineLabelSchema.optional(),
});
export type DeviceCodeRequest = z.infer<typeof DeviceCodeRequestSchema>;

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/**
 * The approval page, exactly: https (http only on loopback), no userinfo, the
 * raw string equal to its parsed href, path `BUS_ROUTES.approve`, no query or
 * fragment. So it can never carry the user code. The schema cannot know the
 * instance origin: the client also checks it (`verificationUriMatches`).
 */
const isSafeVerificationUri = (uri: string): boolean => {
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
  return u.pathname === BUS_ROUTES.approve && !u.search && !u.hash;
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
  .refine((v) => isSafeVerificationUri(v.verification_uri), {
    path: ["verification_uri"],
    message:
      "verification_uri must be https (http only for loopback) at exactly /bus/approve, with no code in it",
  })
  // Belt and braces: the code appears nowhere in the URI, in any case.
  .refine(
    (v) =>
      !v.verification_uri
        .toUpperCase()
        .includes(v.user_code.replace("-", "").toUpperCase()) &&
      !v.verification_uri.toUpperCase().includes(v.user_code.toUpperCase()),
    {
      path: ["verification_uri"],
      message: "verification_uri carries the code",
    },
  );
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

/**
 * True only when `uri` is exactly the instance's approval page:
 * `<instanceOrigin>/bus/approve`, nothing more. A URI with a code segment,
 * a query, a fragment, userinfo or another origin is refused, so the client
 * never prints or opens a link that would approve with one click.
 */
export function verificationUriMatches(
  uri: string,
  instanceOrigin: string,
): boolean {
  try {
    const want = `${new URL(instanceOrigin).origin}${BUS_ROUTES.approve}`;
    return isSafeVerificationUri(uri) && uri === want;
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
