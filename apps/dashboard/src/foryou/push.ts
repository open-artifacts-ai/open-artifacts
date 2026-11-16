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
import { PushKeySchema, R } from "@oa/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiClientError, api } from "../api/client";
import { safePath } from "./model";

export const SW_URL = "/sw.js";
export const SW_SCOPE = "/notifications/sw/";
/** This browser's subscription id on the server (to remove it from here). */
const SUB_KEY = "oa.push.subscription";
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
  /** Design: over the interrupt settings when this browser can't notify at all. */
  unavailableHere: "Browser notifications aren't available here.",
  failed: "Couldn't turn on notifications. Try again.",
  turnOn: "Turn on",
  notNow: "Not now",
  ask: "Get told the moment an agent is waiting?",
  waited: (d: string) =>
    `An agent waited ${d} for you today. Get told the moment one is waiting?`,
  onFor: (browser: string) => `On for ${browser}`,
} as const;

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
    staleTime: 5 * 60_000,
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
export async function turnOn(publicKey: string, label: string) {
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
    localStorage.setItem(SUB_KEY, id);
  } catch {
    // Session only: Settings still sees the browser's own subscription.
  }
  return id;
}

/** Turn off in this browser; true when no browser has it on any more. */
export async function turnOff(): Promise<boolean> {
  const sub = await currentSubscription();
  await sub?.unsubscribe().catch(() => false);
  let id: string | null = null;
  try {
    id = localStorage.getItem(SUB_KEY);
    localStorage.removeItem(SUB_KEY);
  } catch {
    id = null;
  }
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
  let id: string | null = null;
  try {
    id = localStorage.getItem(SUB_KEY);
    localStorage.removeItem(SUB_KEY);
  } catch {
    id = null;
  }
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
