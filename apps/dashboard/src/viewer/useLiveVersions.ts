import { type ArtifactSummary, ArtifactSummarySchema, R } from "@oa/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, api } from "../api/client";
import { qk } from "../api/queries";
import { connectArtifactEvents, type GoneReason, onWake } from "./liveEvents";

/** Design's "Spec for B": act this long after the last event of a burst. */
export const DEBOUNCE_MS = 1_000;
/** View and the safe swap cross-fade the new frame in over this long. */
export const CROSSFADE_MS = 150;
/** Screen reader announcements: at most one per this long. */
export const ANNOUNCE_GAP_MS = 10_000;

/** A new current version: a publish, or a restore of `restoredFrom`. */
export type LiveUpdate = { version: number; restoredFrom?: number };
export type Swapped = LiveUpdate & { prev: number };
/** Deleted (final), or no longer readable by this viewer. */
export type Gone = "deleted" | "unavailable";
/** What the shell knows about the frame it shows, since that frame's load. */
export type FrameState = {
  hello: boolean;
  touched: boolean;
  /** Text selected or a field focused in the frame, right now. */
  engaged: boolean;
};

/**
 * Design's safe-swap rule (option B, revised by C): swap only when the viewer
 * follows Current, the frame's runtime said hello, the viewer hasn't touched
 * the frame since it loaded (a click, key or input; scrolling doesn't count),
 * nothing is selected or focused for typing in it right now, and no menu or
 * dialog is open (the side panel doesn't count). Anything
 * unknown is unsafe, which shows the chip instead. A swap keeps the scroll
 * position.
 */
export const isSafeSwap = (s: {
  following: boolean;
  hello: boolean;
  touched: boolean;
  engaged: boolean;
  chromeOpen: boolean;
}) => s.following && s.hello && !s.touched && !s.engaged && !s.chromeOpen;

/** Design's announcements (one polite status region in the top document). */
export const say = {
  held: (v: number, full: boolean) =>
    `Version ${v} is available. View is ${full ? "at the bottom right" : "in the title bar"}.`,
  swapped: (v: number) => `Updated to version ${v}.`,
  restored: (from: number, v: number) => `Restored v${from} as v${v}.`,
  heldRestore: (from: number, v: number, full: boolean) =>
    `Restored v${from} as v${v}. View is ${full ? "at the bottom right" : "in the title bar"}.`,
  /** Deleted, to its owner. */
  deleted: "You deleted this artifact.",
  unavailable: "This artifact is no longer available to you.",
};

const updateCopy = (u: LiveUpdate, held: boolean, full: boolean) =>
  u.restoredFrom !== undefined
    ? held
      ? say.heldRestore(u.restoredFrom, u.version, full)
      : say.restored(u.restoredFrom, u.version)
    : held
      ? say.held(u.version, full)
      : say.swapped(u.version);

/**
 * The polite announcer: once per debounced batch, at most once per
 * ANNOUNCE_GAP_MS; a hidden tab holds the latest message until it is visible.
 */
function useAnnouncer() {
  const [text, setText] = useState("");
  const last = useRef(0);
  const queued = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const msg = queued.current;
    if (msg === null || document.visibilityState === "hidden") return;
    const wait = last.current + ANNOUNCE_GAP_MS - Date.now();
    if (last.current && wait > 0) {
      timer.current = setTimeout(flush, wait);
      return;
    }
    queued.current = null;
    last.current = Date.now();
    setText(msg);
  }, []);
  useEffect(() => {
    document.addEventListener("visibilitychange", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      clearTimeout(timer.current);
    };
  }, [flush]);
  const announce = useCallback(
    (msg: string) => {
      queued.current = msg;
      flush();
    },
    [flush],
  );
  return { text, announce };
}

/**
 * Live version updates for one viewer: one R.events socket, coalesced into
 * one decision per burst (swap when provably safe, otherwise the chip),
 * plus the deleted or no-access state.
 */
export function useLiveVersions(o: {
  id: string;
  data: ArtifactSummary | undefined;
  /** An explicit /a/<id>/v/<n>: pinned, never swaps. */
  explicit: number | undefined;
  /** /full (the Design's pill copy for announcements). */
  chromeless: boolean;
  embed: boolean;
  /** The shown frame's state, read when a decision is made. */
  frame: () => FrameState;
  /** A menu or dialog is open (not the side panel). */
  chromeOpen: () => boolean;
}) {
  const { id, embed } = o;
  const qc = useQueryClient();
  const { text: announcement, announce } = useAnnouncer();
  // The version shown while following Current: the first one seen, then
  // whatever a swap or View lands on. Never a background refetch.
  const first = useRef<number | undefined>(undefined);
  if (first.current === undefined && o.data)
    first.current = o.data.currentVersion;
  const [shownState, setShown] = useState<number | undefined>(undefined);
  const shown = shownState ?? first.current;
  const [latestSeen, setLatest] = useState(0);
  const following = o.explicit === undefined;
  // Following, only versions acted on count (a refetch is enqueued below);
  // pinned, the artifact's own current version does.
  const latest = Math.max(
    latestSeen,
    (following ? shown : o.data?.currentVersion) ?? 0,
  );
  const [held, setHeld] = useState<LiveUpdate | null>(null);
  const [swapped, setSwapped] = useState<Swapped | null>(null);
  const [preload, setPreload] = useState<
    (Swapped & { mode: "swap" | "view" }) | null
  >(null);
  const [gone, setGone] = useState<Gone | null>(null);
  // The frame being cross-faded out, under the one that just arrived.
  const [leaving, setLeaving] = useState<number | null>(null);
  const fade = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(fade.current), []);

  // Picking Current again (from an explicit version) follows from the latest.
  const [prevExplicit, setPrevExplicit] = useState(o.explicit);
  if (prevExplicit !== o.explicit) {
    setPrevExplicit(o.explicit);
    setHeld(null);
    setSwapped(null);
    setPreload(null);
    if (o.explicit === undefined && latest) setShown(latest);
  }

  const now = useRef({ following, shown, latest, preload, held, gone, o });
  now.current = { following, shown, latest, preload, held, gone, o };

  const decide = useCallback(
    (u: LiveUpdate) => {
      const n = now.current;
      if (n.gone || !n.following || n.shown === undefined) return;
      if (u.version <= n.shown) return;
      const safe = isSafeSwap({
        following: n.following,
        ...n.o.frame(),
        chromeOpen: n.o.chromeOpen(),
      });
      if (safe) {
        setHeld(null);
        setPreload({ ...u, prev: n.shown, mode: "swap" });
        return;
      }
      setHeld(u);
      announce(updateCopy(u, true, n.o.chromeless));
    },
    [announce],
  );

  // Coalescing: restart the debounce on each event; act once, on the highest.
  const pending = useRef<LiveUpdate | null>(null);
  const deferred = useRef<LiveUpdate | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fire = useCallback(() => {
    const u = pending.current;
    pending.current = null;
    if (!u) return;
    setLatest((l) => Math.max(l, u.version));
    if (now.current.preload) {
      deferred.current = u;
      return;
    }
    decide(u);
  }, [decide]);
  // The highest version enqueued so far (the first shown one to start).
  const known = useRef(0);
  const enqueue = useCallback(
    (u: LiveUpdate, refetch = true) => {
      if (u.version <= Math.max(known.current, now.current.shown ?? 0)) return;
      known.current = u.version;
      pending.current = u;
      // The title bar's picker and Versions follow the new current version.
      qc.setQueryData<ArtifactSummary>(qk.artifact(id), (a) =>
        a && u.version > a.currentVersion
          ? { ...a, currentVersion: u.version }
          : a,
      );
      if (refetch) void qc.invalidateQueries({ queryKey: qk.artifact(id) });
      clearTimeout(debounce.current);
      debounce.current = setTimeout(fire, DEBOUNCE_MS);
    },
    [qc, id, fire],
  );

  const sock = useRef<ReturnType<typeof connectArtifactEvents> | null>(null);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);
  const goGone = useCallback(
    (g: Gone) => {
      if (now.current.gone) return;
      sock.current?.close();
      clearTimeout(debounce.current);
      pending.current = null;
      // Nothing for this artifact is fetched again: the copy on screen stays.
      qc.setQueryDefaults(qk.artifact(id), { enabled: false });
      void qc.cancelQueries({ queryKey: qk.artifact(id) });
      setGone(g);
      setHeld(null);
      setSwapped(null);
      setPreload(null);
      announce(
        g === "deleted" && now.current.o.data?.access === "owner"
          ? say.deleted
          : say.unavailable,
      );
    },
    [announce, qc, id],
  );

  // A gone frame, a data socket's 4403 or a focus refetch: ask the API.
  // Readable: carry on (and catch up); 404 or 403: gone.
  const check = useCallback(async () => {
    // A change made from this page (its own delete navigates away): let it
    // settle first, so a deleted artifact is never fetched again.
    if (qc.isMutating() > 0) {
      await new Promise<void>((done) => {
        const off = qc.getMutationCache().subscribe(() => {
          if (qc.isMutating() > 0) return;
          off();
          setTimeout(done, 0);
        });
      });
    }
    if (now.current.gone || unmounted.current) return;
    try {
      const a = await api.get(R.artifact(id), ArtifactSummarySchema);
      qc.setQueryData(qk.artifact(id), a);
      enqueue({ version: a.currentVersion }, false);
      sock.current?.resume();
    } catch (e) {
      if (e instanceof ApiClientError && (e.status === 404 || e.status === 403))
        goGone("unavailable");
      // Signed out: the shell's own 401 handling takes it from here.
      else if (e instanceof ApiClientError && e.status === 401)
        void qc.invalidateQueries({ queryKey: qk.artifact(id) });
      else sock.current?.resume();
    }
  }, [id, qc, enqueue, goGone]);

  // A refetch (on focus, or after an access check) found a newer version.
  const current = o.data?.currentVersion;
  useEffect(() => {
    if (current !== undefined) enqueue({ version: current }, false);
  }, [current, enqueue]);

  // The socket couldn't connect: refetch on window focus instead.
  const down = useRef(false);
  // Bumped by Restore after a delete: a fresh socket.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    void generation;
    const s = connectArtifactEvents({
      id,
      embed,
      onEvent: (e) => {
        if (e.type === "hello") {
          down.current = false;
          enqueue({ version: e.version });
        } else enqueue({ version: e.version, restoredFrom: e.restoredFrom });
      },
      // Deleted is final; "changed" may not concern this viewer: re-check
      // (readable: reconnect and carry on; 404: no longer available).
      onGone: (reason: GoneReason) =>
        reason === "deleted" ? goGone("deleted") : void check(),
      onDown: () => {
        down.current = true;
      },
    });
    sock.current = s;
    const onFocus = () => {
      if (!down.current) return;
      void check();
      s.retry();
    };
    const offWake = onWake(onFocus);
    return () => {
      offWake();
      s.close();
      sock.current = null;
      clearTimeout(debounce.current);
    };
  }, [id, embed, enqueue, check, goGone, generation]);

  /** The owner's Restore on the deleted notice (within the 30-day window). */
  const undelete = useCallback(async () => {
    await api.send("POST", R.restoreDeleted(id), undefined);
    qc.setQueryDefaults(qk.artifact(id), { enabled: true });
    setGone(null);
    setGeneration((g) => g + 1);
    void qc.invalidateQueries({ queryKey: qk.artifact(id) });
    void qc.invalidateQueries({ queryKey: ["artifacts"] });
  }, [id, qc]);

  /** The preloaded frame loaded: it becomes the shown one. */
  const ready = useCallback(
    (version: number) => {
      const p = now.current.preload;
      if (!p || p.version !== version) return;
      setShown(version);
      setPreload(null);
      clearTimeout(fade.current);
      if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        setLeaving(p.prev);
        fade.current = setTimeout(() => setLeaving(null), CROSSFADE_MS);
      }
      if (p.mode === "swap") {
        setSwapped({ version, prev: p.prev, restoredFrom: p.restoredFrom });
        announce(updateCopy(p, false, now.current.o.chromeless));
      } else setSwapped(null);
      setHeld((h) => (h && h.version > version ? h : null));
      const d = deferred.current;
      deferred.current = null;
      // A newer version landed while this one loaded: decide again, on the
      // new frame (untouched, but it must say hello first).
      if (d && d.version > version) setTimeout(() => decide(d), 0);
    },
    [announce, decide],
  );

  /** The shown frame was touched: a swap still loading becomes the chip. */
  const touched = useCallback(() => {
    const p = now.current.preload;
    if (p?.mode !== "swap") return;
    setPreload(null);
    const u = { version: p.version, restoredFrom: p.restoredFrom };
    setHeld(u);
    announce(updateCopy(u, true, now.current.o.chromeless));
  }, [announce]);

  /** View on the chip: preload the held version, then swap to it. */
  const view = useCallback(() => {
    const n = now.current;
    if (!n.held || n.shown === undefined || n.preload) return;
    setPreload({ ...n.held, prev: n.shown, mode: "view" });
  }, []);

  return {
    shown,
    latest,
    held,
    swapped,
    preload,
    leaving,
    gone,
    announcement,
    view,
    ready,
    touched,
    check,
    undelete,
    clearSwapped: useCallback(() => setSwapped(null), []),
  };
}
