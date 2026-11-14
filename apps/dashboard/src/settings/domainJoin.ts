// #2520: turning the domain join on needs a fresh login, the same way adding
// a passkey does (Security): the server answers 401 reauth_required with a
// same-origin reauthUrl, we leave for it, and on the way back the change is
// sent again, within 10 minutes. Turning it off needs no login.
import { useEffect } from "react";
import { ApiClientError } from "../api/client";
import {
  type LoginSettingsPatch,
  usePatchLoginSettings,
} from "../api/loginSettings";
import { useRedirect } from "../auth/redirect";
import { sameOriginUrl } from "../auth/webauthn";

export const DOMAIN_AFTER_REAUTH_KEY = "oa.login.domainAfterReauth";
const AFTER_REAUTH_MS = 10 * 60 * 1000;

type Mark = { at: number; body: LoginSettingsPatch };

/** The change waiting for the login to come back, once; null if none or stale. */
const takeMark = (): LoginSettingsPatch | null => {
  const raw = sessionStorage.getItem(DOMAIN_AFTER_REAUTH_KEY);
  if (raw === null) return null;
  sessionStorage.removeItem(DOMAIN_AFTER_REAUTH_KEY);
  try {
    const m = JSON.parse(raw) as Mark;
    const age = Date.now() - m.at;
    return age >= 0 && age <= AFTER_REAUTH_MS && m.body?.domainJoin === true
      ? m.body
      : null;
  } catch {
    return null;
  }
};

/** A change is waiting for the login to come back (not taken). */
export const domainMarkWaiting = () =>
  sessionStorage.getItem(DOMAIN_AFTER_REAUTH_KEY) !== null;

export const errorLine = (e: unknown) =>
  e instanceof ApiClientError ? e.message : "Something went wrong.";

/**
 * `change` sends a patch; a reauth_required leaves for the login and resends
 * it on return (`onDone` then runs on that page). `onError` gets anything
 * else, worded.
 */
export function useDomainJoin({
  onDone,
  onError,
}: {
  onDone?: () => void;
  onError: (line: string) => void;
}) {
  const patch = usePatchLoginSettings();
  const redirect = useRedirect();
  const change = (body: LoginSettingsPatch, resumed = false) =>
    patch.mutate(body, {
      onSuccess: () => onDone?.(),
      onError: (e) => {
        const url =
          e instanceof ApiClientError && e.code === "reauth_required"
            ? sameOriginUrl(
                (e.details as { reauthUrl?: unknown } | undefined)?.reauthUrl,
              )
            : null;
        // Already back from one login: never loop through another.
        if (!url || resumed) return onError(errorLine(e));
        sessionStorage.setItem(
          DOMAIN_AFTER_REAUTH_KEY,
          JSON.stringify({ at: Date.now(), body } satisfies Mark),
        );
        redirect(url);
      },
    });
  // Back from the login: send it again (taken once, so a second mount or
  // StrictMode's second effect finds nothing).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    const body = takeMark();
    if (body) change(body, true);
  }, []);
  return {
    change: (body: LoginSettingsPatch) => change(body),
    busy: patch.isPending,
  };
}
