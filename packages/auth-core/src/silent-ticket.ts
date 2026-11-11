// The silent ticket (#2026): permission to ATTEMPT a silent Google sign-in
// (prompt=none) for one install, minted by the sign-up host for the person it
// just signed up. It is never a login credential: the broker uses it only to
// choose prompt=none + login_hint, and to refuse relaying a Google token whose
// sub differs. Identity still comes only from Google's own token, which the
// install verifies itself. Deliberately NOT single-use (no nonce store); it is
// short-lived and can only start a sign-in for one install and one sub.
//
// Signed with the sign-up host's key (SIGNUP_BROKER_KEY) over a transcript
// with its own prefix, so it never verifies as a broker ticket
// (`oa-broker-ticket-v1`) or a redeem (`oa-redeem-v1`), and vice versa.
import {
  keyId,
  publicFromPkcs8,
  signTranscript,
  verifyTranscript,
} from "./ed25519.js";

/** A silent ticket's exp may be at most this far ahead (ms). */
export const SILENT_TICKET_TTL_MS = 60_000;

/** A Google `sub`, or a safe stand-in: URL-safe, bounded. */
const SUB_RE = /^[A-Za-z0-9_-]{1,255}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Upper bound for a ticket passed through URLs. */
export const SILENT_TICKET_MAX_LEN = 600;

export type SilentFlow = {
  install: string;
  /** The install's registered origin (registry entry), e.g. https://x.example. */
  aud: string;
  sub: string;
  exp: number;
  nonce: string;
};

export const silentTranscript = (f: SilentFlow) =>
  `oa-silent-v1\n${f.install}\n${f.aud}\n${f.sub}\n${f.exp}\n${f.nonce}`;

/** The `silent` query value: `<exp>.<nonce>.<sub>.<kid>.<sig>`. */
export async function signSilentTicket(
  pkcs8: string,
  f: SilentFlow,
): Promise<string> {
  if (!SUB_RE.test(f.sub) || !NONCE_RE.test(f.nonce))
    throw new Error("bad silent ticket field");
  const kid = await keyId(await publicFromPkcs8(pkcs8));
  const sig = await signTranscript(pkcs8, silentTranscript(f));
  return `${f.exp}.${f.nonce}.${f.sub}.${kid}.${sig}`;
}

/**
 * The ticket's expected sub iff it is signed by one of `keys` over exactly
 * this install and audience, and `now <= exp <= now + SILENT_TICKET_TTL_MS`;
 * otherwise null (the caller falls back to the account picker).
 */
export async function verifySilentTicket(
  keys: readonly { kid: string; x: string }[],
  ticket: string,
  ctx: { install: string; aud: string },
  now: number,
): Promise<{ sub: string } | null> {
  if (ticket.length > SILENT_TICKET_MAX_LEN) return null;
  const parts = ticket.split(".");
  if (parts.length !== 5) return null;
  const [expS, nonce, sub, kid, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d{1,16}$/.test(expS) || !kid || !sig) return null;
  if (!SUB_RE.test(sub) || !NONCE_RE.test(nonce)) return null;
  const exp = Number(expS);
  if (exp < now || exp > now + SILENT_TICKET_TTL_MS) return null;
  for (const k of keys) {
    if (k.kid !== kid) continue;
    try {
      if ((await keyId(k.x)) !== kid) continue;
    } catch {
      continue;
    }
    if (
      await verifyTranscript(
        k.x,
        silentTranscript({ ...ctx, sub, exp, nonce }),
        sig,
      )
    )
      return { sub };
  }
  return null;
}
