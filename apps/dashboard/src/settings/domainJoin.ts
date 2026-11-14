// #2520: turning the domain join on needs a fresh login, the same way adding
// a passkey does (Security): the server answers 401 reauth_required with a
// same-origin reauthUrl, we leave for it, and on the way back the change is
// sent again, within 10 minutes. A hosted instance applies it with a
// redeploy (409 apply_pending): we say so and watch the settings until the
// change shows, about a minute.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, api } from "../api/client";
import {
  LOGIN_SETTINGS,
  type LoginSettings,
  type LoginSettingsPut,
  LoginSettingsSchema,
  putFailure,
  putLoginSettings,
  qkLogin,
  useSetLoginSettings,
} from "../api/loginSettings";
import { useRedirect } from "../auth/redirect";
import { sameOriginUrl } from "../auth/webauthn";

export const DOMAIN_AFTER_REAUTH_KEY = "oa.login.domainAfterReauth";
const AFTER_REAUTH_MS = 10 * 60 * 1000;
/** How often, and how long, to look for an applied change. */
export const APPLY_POLL_MS = 5_000;
export const APPLY_GIVE_UP_MS = 3 * 60 * 1000;

type Mark = { at: number; body: LoginSettingsPut };

/** The change waiting for the login to come back, once; null if none or stale. */
const takeMark = (): LoginSettingsPut | null => {
  const raw = sessionStorage.getItem(DOMAIN_AFTER_REAUTH_KEY);
  if (raw === null) return null;
  sessionStorage.removeItem(DOMAIN_AFTER_REAUTH_KEY);
  try {
    const m = JSON.parse(raw) as Mark;
    const age = Date.now() - m.at;
    return age >= 0 &&
      age <= AFTER_REAUTH_MS &&
      typeof m.body?.autoJoin === "boolean" &&
      Array.isArray(m.body.domains)
      ? m.body
      : null;
  } catch {
    return null;
  }
};

/** A change is waiting for the login to come back (not taken). */
export const domainMarkWaiting = () =>
  sessionStorage.getItem(DOMAIN_AFTER_REAUTH_KEY) !== null;

/** The body that turns the join on or off: on adds the owner's provable domain. */
export const joinBody = (
  s: LoginSettings,
  autoJoin: boolean,
): LoginSettingsPut => ({
  autoJoin,
  domains:
    autoJoin && s.provable && !s.domains.includes(s.provable)
      ? [...s.domains, s.provable]
      : s.domains,
});

export type SaveState = "idle" | "saving" | "pending" | "saved" | "failed";

/**
 * `change` sends a PUT. A reauth_required leaves for the login and resends it
 * on return; apply_pending turns `state` to "pending" until the settings
 * show it ("saved"), or 3 minutes pass ("failed").
 */
export function useDomainJoin({ onDone }: { onDone?: () => void } = {}) {
  const set = useSetLoginSettings();
  const redirect = useRedirect();
  const [state, setState] = useState<SaveState>("idle");
  const done = useRef(onDone);
  done.current = onDone;
  const [want, setWant] = useState<boolean | null>(null);
  const watch = useQuery({
    queryKey: qkLogin,
    queryFn: ({ signal }) =>
      api.get(LOGIN_SETTINGS, LoginSettingsSchema, signal),
    enabled: state === "pending",
    refetchInterval: state === "pending" ? APPLY_POLL_MS : false,
  });
  const seen = watch.data?.autoJoin;
  useEffect(() => {
    if (state !== "pending" || want === null) return;
    if (seen === want) {
      setState("saved");
      done.current?.();
      return;
    }
    const t = setTimeout(() => setState("failed"), APPLY_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [state, want, seen]);

  const send = async (body: LoginSettingsPut, resumed: boolean) => {
    setState("saving");
    setWant(body.autoJoin);
    try {
      set(await putLoginSettings(body));
      setState("idle");
      done.current?.();
    } catch (e) {
      const why = putFailure(e);
      if (why === "pending") return setState("pending");
      const url =
        why === "reauth" && e instanceof ApiClientError
          ? sameOriginUrl(
              (e.details as { reauthUrl?: unknown } | undefined)?.reauthUrl,
            )
          : null;
      // Already back from one login: never loop through another.
      if (!url || resumed) return setState("failed");
      sessionStorage.setItem(
        DOMAIN_AFTER_REAUTH_KEY,
        JSON.stringify({ at: Date.now(), body } satisfies Mark),
      );
      redirect(url);
    }
  };
  // Back from the login: send it again (taken once, so a second mount or
  // StrictMode's second effect finds nothing).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    const body = takeMark();
    if (body) void send(body, true);
  }, []);
  return {
    change: (body: LoginSettingsPut) => void send(body, false),
    state,
    busy: state === "saving" || state === "pending",
  };
}
