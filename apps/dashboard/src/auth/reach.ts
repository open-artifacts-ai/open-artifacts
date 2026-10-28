// Who can sign in here (review items 11 and 37): Design's copy for a refused
// invite, an invite that may not sign in, and a share whose recipient can't
// sign in yet. The server's messages are never shown for these.
import { useAuthProviders } from "../api/auth";
import type {
  InviteUnreachableReason,
  SignInProviderId,
} from "../api/contract";

/** "a", "a or b", "a, b or c". */
export const orList = (list: readonly string[]) =>
  list.length < 2
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;

/** Only Google lists the sign-in domains; without it, a generic phrase. */
const ANY_DOMAIN = "your sign-in domains";

/** The org's sign-in domains as one phrase, from GET AUTH.providers. */
export function useSignInDomains(): string {
  const google = useAuthProviders().data?.providers.find(
    (p) => p.id === "google",
  );
  const list = google?.id === "google" ? google.domains : [];
  return list.length ? orList(list) : ANY_DOMAIN;
}

/** 400 invite_unreachable, under the email field. */
export const inviteRefusedCopy = (
  reason: InviteUnreachableReason,
  email: string,
  domains: string,
) =>
  reason === "outside_domains"
    ? `${email} can't sign in here. Only addresses at ${domains} can. Use one of those addresses.`
    : `No sign-in method here fits ${email}. Use another address, or ask the owner to add a sign-in method.`;

/** 201 with signIn "uncertain": the invite stands, but warn (inline, under its heading). */
export const inviteUncertainCopy = (email: string, domains: string) =>
  `${email} is outside ${domains}, so they may not be able to sign in. If they can't, invite an address at ${domains}.`;

// The email's phrases (server signInSentence), about the recipient.
const METHOD_PHRASE: Record<SignInProviderId, string> = {
  google: "their Google account",
  access: "your organization's single sign-on",
  email: "a one-time code sent to that address",
};
const METHOD_ORDER: readonly SignInProviderId[] = ["google", "access", "email"];

/**
 * How the recipient signs in, from the server's `signInMethods` for that
 * address: "their Google account or a one-time code sent to that address".
 * Null when the server didn't say (older) or nothing admits them.
 */
export const signInWith = (
  methods: readonly SignInProviderId[] | undefined,
): string | null => {
  const parts = METHOD_ORDER.filter((m) => methods?.includes(m)).map(
    (m) => METHOD_PHRASE[m],
  );
  return parts.length ? parts.join(" or ") : null;
};
