import { type ContentUrl, ContentUrlSchema, LIMITS, R } from "@oa/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, api } from "../api/client";
import {
  reportApiError,
  reportApiSuccess,
  shouldRetry,
} from "../api/queryClient";

const RETRY_MS = 15_000;

type Control = { load: () => Promise<string | null>; stale: () => boolean };

/** How long an early fetch stays usable; the viewer normally takes it within a second. */
const EARLY_MS = 10_000;
let early: {
  id: string;
  at: number;
  p: Promise<ContentUrl | null>;
} | null = null;

/**
 * Starts an artifact's content-url fetch alongside its info (#693), before the
 * version to show is known: `v` when the address names one, else the current
 * version. The viewer adopts it when the served version is the one it shows.
 */
export function prefetchContentUrl(id: string, v?: number) {
  early = {
    id,
    at: Date.now(),
    p: api.get(R.contentUrl(id, v), ContentUrlSchema).catch(() => null),
  };
}

/** The early fetch for this artifact, once. */
function takeEarly(id: string, v: number): Promise<ContentUrl | null> | null {
  const e = early;
  if (!e || e.id !== id) return null;
  early = null;
  if (Date.now() - e.at > EARLY_MS) return null;
  // Not the version shown (it changed meanwhile) or failed: fetch as usual.
  return e.p.then((c) => (c?.version === v ? c : null));
}

/**
 * Signed content URL, refetched 60 s before it expires (null expiry: never), and
 * again on focus or visibility change once the local clock says it is past that
 * point (timers stall while a laptop sleeps or a tab is throttled).
 * `url` follows refreshes only until the iframe fires `onLoad`; after that it is
 * frozen so a refresh never reloads the loaded document. `current` always follows
 * refreshes (for links opened outside the iframe); `fresh()` says whether it is
 * still inside its lifetime and `refresh()` fetches a new one.
 * `notFound` stops retrying; other errors are in `error` (retried unless 4xx/quota).
 */
export function useContentUrl(id: string, v: number, stopped = false) {
  const client = useQueryClient();
  // Gone (deleted or no access): keep the URL on screen, never fetch again.
  const halt = useRef(stopped);
  halt.current = stopped;
  const [fresh, setFresh] = useState<ContentUrl | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const ctl = useRef<Control | null>(null);

  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<string | null> | null = null;
    let fetchedAt = 0;
    let lifetime = 0;
    setFresh(null);
    setLoaded(null);
    setNotFound(false);
    setError(null);
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(load, ms);
    };
    // Relative to local fetch time, so client clock skew can't matter.
    const stale = () => Date.now() > fetchedAt + lifetime;
    const fetchUrl = () => api.get(R.contentUrl(id, v), ContentUrlSchema);
    const load = (): Promise<string | null> => {
      if (halt.current) return Promise.resolve(null);
      const first = takeEarly(id, v);
      pending ??= (
        first ? first.then((c) => c ?? fetchUrl()) : fetchUrl()
      ).then(
        (c) => {
          pending = null;
          if (dead) return null;
          fetchedAt = Date.now();
          lifetime =
            c.expiresAt === null
              ? Number.POSITIVE_INFINITY
              : Number.isFinite(Date.parse(c.expiresAt))
                ? (LIMITS.signedUrlTtlSec - 60) * 1000
                : RETRY_MS;
          setFresh(c);
          setError(null);
          reportApiSuccess(client);
          if (Number.isFinite(lifetime)) schedule(lifetime);
          return c.url;
        },
        (e) => {
          pending = null;
          if (dead) return null;
          if (e instanceof ApiClientError && e.status === 404) {
            setNotFound(true);
            return null;
          }
          reportApiError(client, e);
          setError(e);
          if (shouldRetry(0, e)) schedule(RETRY_MS);
          return null;
        },
      );
      return pending;
    };
    const wake = () => {
      if (document.visibilityState !== "hidden" && fetchedAt && stale())
        void load();
    };
    ctl.current = { load, stale };
    load();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      dead = true;
      ctl.current = null;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [id, v, client]);

  const url = loaded ?? fresh?.url ?? null;
  const onLoad = useCallback(
    () => setLoaded((l) => l ?? fresh?.url ?? null),
    [fresh],
  );
  const isFresh = useCallback(() => !!ctl.current && !ctl.current.stale(), []);
  const refresh = useCallback(async () => {
    const c = ctl.current;
    if (!c) return null;
    setRefreshing(true);
    try {
      return await c.load();
    } finally {
      setRefreshing(false);
    }
  }, []);
  return {
    url,
    current: fresh?.url ?? null,
    onLoad,
    notFound,
    error,
    fresh: isFresh,
    refresh,
    refreshing,
  };
}
