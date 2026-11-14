// #2520: turning the domain join on needs a fresh login, the same way adding
// a passkey does (Security): the server answers 401 reauth_required with a
// same-origin reauthUrl and we leave for it. On the way back nothing is sent
// by itself (OA Axe L1): the page asks again, and the owner confirms. An
// accepted change may still be applying (a hosted redeploy, about a minute:
// `applying`): we say so and watch the settings until it's done. A 409
// apply_pending is a refusal: an earlier change is still applying.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
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

/**
 * The body that turns the join on or off. On sends only the owner's provable
 * domain (OA Axe L2), never a list it didn't prove; off keeps the list.
 */
export const joinBody = (
  s: LoginSettings,
  autoJoin: boolean,
): LoginSettingsPut =>
  autoJoin
    ? { autoJoin, domains: s.provable ? [s.provable] : [] }
    : { autoJoin, domains: s.domains };

export type SaveState =
  | "idle"
  | "saving"
  | "pending"
  | "saved"
  | "failed"
  | "unproven"
  | "busy_elsewhere";

/**
 * `change` sends a PUT. A reauth_required leaves for the login; `resume` is
 * the change to confirm again on return. An accepted change that's still
 * applying turns `state` to "pending" until the settings say it's done
 * ("saved"), or 3 minutes pass ("failed"). domain_unproven sets `locked`:
 * nothing offers to resend it.
 */
export function useDomainJoin({ onDone }: { onDone?: () => void } = {}) {
  const set = useSetLoginSettings();
  const qc = useQueryClient();
  const redirect = useRedirect();
  const [state, setState] = useState<SaveState>("idle");
  const done = useRef(onDone);
  done.current = onDone;
  /** domain_unproven's domain, when the server named one. */
  const [unproven, setUnproven] = useState<string | null>(null);
  const [since, setSince] = useState(0);
  const watch = useQuery({
    queryKey: qkLogin,
    queryFn: ({ signal }) =>
      api.get(LOGIN_SETTINGS, LoginSettingsSchema, signal),
    enabled: state === "pending",
    refetchInterval: state === "pending" ? APPLY_POLL_MS : false,
  });
  const applied = watch.dataUpdatedAt >= since && watch.data?.applying !== true;
  useEffect(() => {
    if (state !== "pending") return;
    if (applied) {
      setState("saved");
      done.current?.();
      return;
    }
    const t = setTimeout(() => setState("failed"), APPLY_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [state, applied]);

  const send = async (body: LoginSettingsPut) => {
    setState("saving");
    try {
      const saved = await putLoginSettings(body);
      set(saved);
      if (saved.applying) {
        setSince(Date.now());
        setState("pending");
        // Ask now, then every APPLY_POLL_MS while it applies.
        void qc.invalidateQueries({ queryKey: qkLogin });
        return;
      }
      setState("idle");
      done.current?.();
    } catch (e) {
      const f = putFailure(e);
      if (f.why === "pending") return setState("busy_elsewhere");
      if (f.why === "unproven") {
        setUnproven(f.domain);
        return setState("unproven");
      }
      const url = f.why === "reauth" ? sameOriginUrl(f.url) : null;
      if (!url) return setState("failed");
      sessionStorage.setItem(
        DOMAIN_AFTER_REAUTH_KEY,
        JSON.stringify({ at: Date.now(), body } satisfies Mark),
      );
      redirect(url);
    }
  };
  // Back from the login: the change to confirm again (taken once, so a
  // second mount or StrictMode's second effect finds nothing).
  const [resume, setResume] = useState<LoginSettingsPut | null>(null);
  useEffect(() => {
    const body = takeMark();
    if (body?.autoJoin) setResume(body);
  }, []);
  return {
    change: (body: LoginSettingsPut) => {
      setResume(null);
      void send(body);
    },
    resume,
    dismissResume: () => setResume(null),
    state,
    unproven,
    /** domain_unproven: turning on again would send the same unproven domain. */
    locked: state === "unproven",
    busy: state === "saving" || state === "pending",
  };
}
