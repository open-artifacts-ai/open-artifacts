/**
 * #2512 slice 3: browser notifications for "Needs you". The inbox contract's
 * push routes (R.mePushKey, R.mePushSubscriptions, R.mePushSubscription) and
 * this browser's subscription.
 *
 * - The service worker is /sw.js from the app origin root, registered with a
 *   narrow scope so it never takes over pages (it only handles push and
 *   notification clicks), and never on the mock worker's scope.
 * - Permission is asked only from a click ("Turn on", or the Settings switch).
 * - A notification opens its item's same-origin path; the app checks it again.
 */
import {
  PushKeySchema,
  type PushSubscriptionPatchBody,
  type PushSubscriptions,
  PushSubscriptionsSchema,
  R,
} from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiClientError, api } from "../api/client";
import { useMe } from "../auth/useMe";
import { safePath } from "./model";

type PushSubscriptionItem = PushSubscriptions["items"][number];
/** PATCH R.mePushSubscription's 200 body (shared has no named schema): this browser's switches. */
const PushSubscriptionSwitchesSchema =
  PushSubscriptionsSchema.shape.items.element.pick({
    needsYou: true,
    updates: true,
  });

export const SW_URL = "/sw.js";
export const SW_SCOPE = "/notifications/sw/";
/**
 * This browser's subscription on the server, with the member it belongs to:
 * `{ userId, id }`, so one member's id is never read as another's (Axe). The
 * old unscoped key ("oa.push.subscription") is ignored and cleared.
 */
const SUB_KEY = "oa.push.subscription.v2";
const OLD_SUB_KEY = "oa.push.subscription";

type StoredSub = { userId: string; id: string };

function storedSub(): StoredSub | null {
  try {
    localStorage.removeItem(OLD_SUB_KEY);
    const v = JSON.parse(localStorage.getItem(SUB_KEY) ?? "null") as unknown;
    const o = v as Partial<StoredSub> | null;
    return o && typeof o.userId === "string" && typeof o.id === "string"
      ? { userId: o.userId, id: o.id }
      : null;
  } catch {
    return null;
  }
}

function clearStoredSub() {
  try {
    localStorage.removeItem(SUB_KEY);
    localStorage.removeItem(OLD_SUB_KEY);
  } catch {
    // Session only.
  }
}
const NUDGE_KEY = "oa.push.nudge.dismissed";

/** OA Product's words (#2512, slice 3) and Design's (screens, tab 3), word for word. */
export const PUSH_WORDS = {
  cant: "This browser can't show notifications.",
  /** OA Product: the full line under the Needs you row when blocked. */
  blocked:
    "Your browser is blocking notifications from this site. Allow them in your browser's site settings.",
  /** The "This browser" cell, short (Design and OA Product). */
  blockedHere: "Blocked in this browser",
  notAvailable: "Not available",
  failed: "Couldn't turn on notifications. Try again.",
  turnOn: "Turn on",
  notNow: "Not now",
  ask: "Get told the moment an agent is waiting?",
  waited: (d: string) =>
    `An agent waited ${d} for you today. Get told the moment one is waiting?`,
  onFor: (browser: string) => `On for ${browser}`,
  /** Updates needs this browser subscribed first. */
  turnOnFirst: "Turn on Needs you here first",
} as const;

/**
 * #2942, #2943: the Settings → Notifications words that say what to do and who
 * does it. PROVISIONAL until OA Product-2 answers: every string is here so it
 * can be swapped in one place.
 */
export const NOTIF_WORDS = {
  /** The matrix column for the inbox (#2942: there is no app, only the browser). */
  inOA: "In Open Artifacts",
  /** Under the account settings when push can't reach this browser (#2943). */
  applyLater: "These apply as soon as notifications reach a browser.",
  /** The server has no push key: an owner step. */
  noKey: (site: string) =>
    `Browser notifications aren't turned on for ${site || "this site"} yet. The owner turns them on by upgrading the instance.`,
  noKeyCell: "Not turned on yet",
  /** iPhone or iPad Safari, not added to the Home Screen: a person step. */
  iosHome: (site: string) =>
    `On iPhone, notifications work once you add ${site || "this site"} to your Home Screen: tap Share, then Add to Home Screen, then open it from there.`,
  iosCell: "Add to Home Screen first",
} as const;

/** iPhone, iPad or iPod, including an iPad that says it is a Mac. */
export const isIos = (
  ua = navigator.userAgent,
  platform = navigator.platform,
  touch = navigator.maxTouchPoints,
) => /iPhone|iPad|iPod/.test(ua) || (platform === "MacIntel" && touch > 1);

/** Opened from the Home Screen (iOS `navigator.standalone`, or display-mode standalone). */
export const isStandalone = () =>
  (navigator as { standalone?: boolean }).standalone === true ||
  (typeof matchMedia === "function" &&
    matchMedia("(display-mode: standalone)").matches);

/**
 * iOS web push exists only for a site added to the Home Screen: in a Safari tab
 * there is no PushManager. So: iOS, not standalone, and no push support here.
 */
export const iosNeedsHomeScreen = () =>
  isIos() && !isStandalone() && !pushSupported();

/** "Chrome on this Mac": this browser, for the browser column's "On for …" (slice 3). */
export function thisBrowser(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "this browser";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "phone"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "PC"
            : "computer";
  return `${browser} on this ${device}`;
}

/** "1 minute", "40 minutes", "2 hours". */
export function waitedFor(ms: number): string | null {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return null;
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"}`;
  const h = Math.floor(min / 60);
  return `${h} ${h === 1 ? "hour" : "hours"}`;
}

/** The browser can do web push: a service worker, PushManager and Notification. */
export const pushSupported = () =>
  typeof window !== "undefined" &&
  !!navigator.serviceWorker &&
  !!(window as { PushManager?: unknown }).PushManager &&
  !!(window as { Notification?: unknown }).Notification;

export const permission = (): NotificationPermission | "unsupported" =>
  pushSupported() ? Notification.permission : "unsupported";

/** The server's push key, or null when the server has none (404 push_unavailable). */
export const usePushKey = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: ["push-key"],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }) => {
      try {
        return (await api.get(R.mePushKey, PushKeySchema, signal)).publicKey;
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 404) return null;
        throw e;
      }
    },
  });

const b64url = (s: string) => {
  const b = atob(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** Our registration, ready to subscribe (the worker active). */
async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(SW_URL, {
    scope: SW_SCOPE,
  });
  const w = reg.installing ?? reg.waiting;
  if (!reg.active && w)
    await new Promise<void>((ok) => {
      const on = () => {
        if (w.state === "activated") {
          w.removeEventListener("statechange", on);
          ok();
        }
      };
      w.addEventListener("statechange", on);
      on();
    });
  return reg;
}

/** This browser's push subscription, if it has one. */
export async function currentSubscription() {
  if (!pushSupported()) return null;
  // getRegistration answers the closest registration covering the path (the
  // mock API's worker at "/", say): only our own scope counts.
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  if (!reg || !new URL(reg.scope, location.origin).pathname.endsWith(SW_SCOPE))
    return null;
  return (await reg.pushManager.getSubscription()) ?? null;
}

export class PermissionRefused extends Error {
  constructor(readonly state: NotificationPermission) {
    super(`notifications ${state}`);
  }
}

/** Turn on in this browser: call from a click only (the browser asks then). */
export async function turnOn(publicKey: string, label: string, userId: string) {
  turningOn = true;
  try {
    return await subscribeHere(publicKey, label, userId);
  } finally {
    turningOn = false;
  }
}

/** A turn-on is under way: the reconcile below leaves the browser alone. */
let turningOn = false;

async function subscribeHere(publicKey: string, label: string, userId: string) {
  const p = await Notification.requestPermission();
  if (p !== "granted") throw new PermissionRefused(p);
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64url(publicKey),
    }));
  const j = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  const { id } = await api.send(
    "POST",
    R.mePushSubscriptions,
    {
      endpoint: j.endpoint ?? sub.endpoint,
      keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" },
      label,
    },
    z.object({ id: z.string() }),
  );
  try {
    localStorage.setItem(SUB_KEY, JSON.stringify({ userId, id }));
  } catch {
    // Session only: Settings still sees the browser's own subscription.
  }
  return id;
}

/** Turn off in this browser; true when no browser has it on any more. */
export async function turnOff(): Promise<boolean> {
  const sub = await currentSubscription();
  await sub?.unsubscribe().catch(() => false);
  const id = storedSub()?.id ?? null;
  clearStoredSub();
  if (id) await api.send("DELETE", R.mePushSubscription(id), undefined);
  const left = await api.get(
    R.mePushSubscriptions,
    z.object({ items: z.array(z.object({ id: z.string() })) }),
  );
  return left.items.length === 0;
}

/** Each sign-out step waits at most this long, then sign-out goes on (Axe M1). */
export const SIGN_OUT_STEP_MS = 1500;

/** `p`, or undefined after `ms`; never rejects. */
const bounded = <T>(p: Promise<T>, ms: number) =>
  new Promise<T | undefined>((done) => {
    const t = setTimeout(() => done(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        done(v);
      },
      () => {
        clearTimeout(t);
        done(undefined);
      },
    );
  });

/**
 * Axe M1: signing out turns browser notifications off for this browser.
 * Call before the logout request ends the session: first remove this
 * browser's subscription on the server (PROVISIONAL: R.mePushSubscription
 * DELETE), then the browser's own. Best effort: each step waits at most
 * `stepMs`, and this never throws, so sign-out never fails or hangs on it.
 */
export async function forgetThisBrowser(
  stepMs = SIGN_OUT_STEP_MS,
): Promise<void> {
  // An id kept under the old unscoped key still gets its row removed here.
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(OLD_SUB_KEY);
  } catch {
    legacy = null;
  }
  const id = storedSub()?.id ?? legacy;
  clearStoredSub();
  if (id) {
    const stop = new AbortController();
    await bounded(
      api.send(
        "DELETE",
        R.mePushSubscription(id),
        undefined,
        undefined,
        stop.signal,
      ),
      stepMs,
    );
    stop.abort();
  }
  await bounded(
    (async () => {
      const sub = await currentSubscription();
      await sub?.unsubscribe();
    })(),
    stepMs,
  );
}

export const pushSubsKey = ["push-subscriptions"] as const;

/** This browser's subscription id on the server, if it kept one for this member. */
export function thisSubscriptionId(userId: string): string | null {
  const st = storedSub();
  return st && st.userId === userId ? st.id : null;
}

/** The signed-in member's id, or "" before they are known. */
export function useMeId(): string {
  const me = useMe();
  return me.status === "authed" ? me.me.user.id : "";
}

/** Every browser the member turned notifications on in, with its switches. */
export const usePushSubscriptions = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: pushSubsKey,
    queryFn: ({ signal }) =>
      api.get(R.mePushSubscriptions, PushSubscriptionsSchema, signal),
  });

/** This browser's own row in the list, by the id it kept (undefined: not subscribed). */
export const thisSubscription = (
  list: PushSubscriptions | undefined,
  userId: string,
): PushSubscriptionItem | undefined => {
  const id = userId ? thisSubscriptionId(userId) : null;
  return id ? list?.items.find((x) => x.id === id) : undefined;
};

/**
 * PATCH this browser's switches, shown at once; a
 * failure puts them back.
 */
export const usePatchSubscription = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; body: PushSubscriptionPatchBody }) =>
      api.send(
        "PATCH",
        R.mePushSubscription(v.id),
        v.body,
        PushSubscriptionSwitchesSchema,
      ),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: pushSubsKey });
      const prev = qc.getQueryData<PushSubscriptions>(pushSubsKey);
      if (prev)
        qc.setQueryData<PushSubscriptions>(pushSubsKey, {
          items: prev.items.map((x) =>
            x.id === v.id ? { ...x, ...v.body } : x,
          ),
        });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(pushSubsKey, ctx.prev);
    },
    onSuccess: (r, v) =>
      qc.setQueryData<PushSubscriptions>(
        pushSubsKey,
        (cur) =>
          cur && {
            items: cur.items.map((x) => (x.id === v.id ? { ...x, ...r } : x)),
          },
      ),
  });
};

/** Whether this browser has notifications on (its own subscription), read once. */
export function useThisBrowserOn() {
  const [on, setOn] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void currentSubscription().then(
      (s) => live && setOn(!!s),
      () => live && setOn(false),
    );
    return () => {
      live = false;
    };
  }, []);
  return [on, setOn] as const;
}

/** "Not now" keeps the nudge away on this browser for this long, at least (Design). */
export const NUDGE_QUIET_MS = 30 * 24 * 3600_000;
/** "Not now" was said on this browser, less than 30 days ago (or as "1", by an older build, for good). */
export const nudgeDismissed = (now = Date.now()) => {
  try {
    const v = localStorage.getItem(NUDGE_KEY);
    if (v === null) return false;
    if (v === "1") return true;
    const at = Number(v);
    return Number.isFinite(at) && now - at < NUDGE_QUIET_MS;
  } catch {
    return false;
  }
};
export const dismissNudge = (now = Date.now()) => {
  try {
    localStorage.setItem(NUDGE_KEY, String(now));
  } catch {
    // Session only.
  }
};

/**
 * A notification click in another window posts its item's path here; the app
 * opens it if it is a same-origin path (checked again, never trusted).
 */
export function useNotificationOpen(go: (path: string) => void) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!pushSupported()) return;
    const on = (e: MessageEvent) => {
      const d = e.data as { oa?: string; href?: unknown } | null;
      if (d?.oa !== "notification-open") return;
      const path = safePath(typeof d.href === "string" ? d.href : "");
      if (!path) return;
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      go(path);
    };
    const c = navigator.serviceWorker;
    c.addEventListener("message", on);
    return () => c.removeEventListener("message", on);
  }, [go, qc]);
}

/**
 * Axe: a browser subscription belongs to the member who turned it on. When a
 * session ends without the sign-out button (it expired, cookies were cleared)
 * and another member signs in on this profile, the old member's subscription
 * would still deliver here. Once this member's list is read: if the browser
 * has a subscription that isn't one of theirs (the kept id is another
 * member's, or isn't in their list), remove it from the browser (the push
 * service then answers 410 and the server drops the row) and forget the id.
 * Never throws; each step is bounded; a list that hasn't loaded, or failed,
 * removes nothing. Returns true when it removed one.
 */
export async function dropForeignSubscription(
  userId: string,
  list: { id: string }[],
  stepMs = SIGN_OUT_STEP_MS,
): Promise<boolean> {
  if (!userId || turningOn) return false;
  const st = storedSub();
  if (st && st.userId === userId && list.some((x) => x.id === st.id))
    return false;
  const sub = await bounded(currentSubscription(), stepMs);
  if (turningOn) return false;
  clearStoredSub();
  if (!sub) return false;
  await bounded(sub.unsubscribe(), stepMs);
  return true;
}

/**
 * Mount once in the signed-in app. No network until the browser itself has a
 * subscription (asked of the PushManager, locally): only then is this
 * member's list read and dropForeignSubscription run. A browser with none,
 * or a server with no push key, never costs a request on ordinary pages.
 */
export function useDropForeignSubscription() {
  const me = useMe();
  const userId = me.status === "authed" ? me.me.user.id : "";
  const qc = useQueryClient();
  const [here, setHere] = useState(false);
  useEffect(() => {
    if (!userId || !pushSupported()) return;
    let live = true;
    void currentSubscription().then(
      (s) => live && setHere(!!s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [userId]);
  const subs = usePushSubscriptions(here && !!userId);
  const items = subs.isSuccess && !subs.isFetching ? subs.data.items : null;
  useEffect(() => {
    if (!items || !userId) return;
    void dropForeignSubscription(userId, items).then((gone) => {
      if (!gone) return;
      setHere(false);
      void qc.invalidateQueries({ queryKey: pushSubsKey });
    });
  }, [items, userId, qc]);
}
