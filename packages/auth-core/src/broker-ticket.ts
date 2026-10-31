// The platform-principal ticket (design v7 4.3, "Broker change"). The
// Provisioning API (and post-M1 signup) are registry entries like installs,
// but the broker charges an install's bucket before anything is
// authenticated, so anyone could drain theirs and lock the admin out. For
// these ids the broker first requires a ticket: an Ed25519 signature by the
// entry's key (ADMIN_BROKER_KEY) over the flow, at most 10 min ahead.
import {
  keyId,
  publicFromPkcs8,
  signRequest,
  verifyRequest,
} from "./ed25519.js";

/**
 * Mirrors PLATFORM_PRINCIPAL_IDS in @oa/provision/names.ts (the broker
 * cannot import provision at runtime); a broker test pins the two equal.
 */
export const PLATFORM_PRINCIPAL_IDS: readonly string[] = Object.freeze([
  "i000000admin",
  "i00000signup",
]);
export const isPlatformPrincipal = (id: string) =>
  PLATFORM_PRINCIPAL_IDS.includes(id);

/** A ticket's exp may be at most this far ahead (ms). */
export const BROKER_TICKET_TTL_MS = 10 * 60_000;

export type TicketFlow = { install: string; state: string; challenge: string };

export const ticketTranscript = (f: TicketFlow & { exp: number }) =>
  `oa-broker-ticket-v1\n${f.install}\n${f.state}\n${f.challenge}\n${f.exp}`;

// The signature reuses the Ed25519 request signer under its own "path", so
// a ticket can never verify as a redeem or any other signed broker POST.
const TICKET_PATH = "/google/authorize#ticket";

/** The `ticket` query value: `<exp>.<kid>.<sig>` (exp in epoch ms). */
export async function signBrokerTicket(
  pkcs8: string,
  f: TicketFlow & { exp: number },
): Promise<string> {
  const kid = await keyId(await publicFromPkcs8(pkcs8));
  const sig = await signRequest(pkcs8, TICKET_PATH, kid, ticketTranscript(f));
  return `${f.exp}.${kid}.${sig}`;
}

/**
 * True iff `ticket` is signed by one of `keys` (its kid derives from its x)
 * over this flow, and `now <= exp <= now + BROKER_TICKET_TTL_MS`.
 */
export async function verifyBrokerTicket(
  keys: readonly { kid: string; x: string }[],
  ticket: string,
  f: TicketFlow,
  now: number,
): Promise<boolean> {
  const parts = ticket.split(".");
  if (parts.length !== 3) return false;
  const [expS, kid, sig] = parts as [string, string, string];
  if (!/^\d{1,16}$/.test(expS) || !kid || !sig) return false;
  const exp = Number(expS);
  if (exp < now || exp > now + BROKER_TICKET_TTL_MS) return false;
  for (const k of keys) {
    if (k.kid !== kid) continue;
    try {
      if ((await keyId(k.x)) !== kid) continue;
    } catch {
      continue;
    }
    if (
      await verifyRequest(
        k.x,
        TICKET_PATH,
        kid,
        ticketTranscript({ ...f, exp }),
        sig,
      )
    )
      return true;
  }
  return false;
}
