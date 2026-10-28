import {
  type DataDoc,
  type DataQueryInput,
  type Format,
  NAVIGATE_PATH_RE,
  type Page,
  type ShellToArtifact,
} from "@oa/shared";
import {
  type Bridge,
  createBridge,
  RuntimeError,
  type Schemas,
} from "./bridge.js";

/** A db.query page; `restarted` is set when it is the first page again after cursor_stale. */
export type QueryPage = Page<DataDoc> & { restarted?: true };

export { RuntimeError, type RuntimeErrorCode } from "./bridge.js";

export type Theme = "light" | "dark";
export type Viewer = { email: string; name: string | null };
/**
 * A subscribe() delivery. `resync: true` (with empty docs/deleted) means the
 * live connection was re-established and changes may have been missed:
 * refetch your data when resync is true. `offline: true` (with empty
 * docs/deleted) means live changes are paused (the connection was refused or
 * keeps failing); tell the viewer, and expect a resync when it recovers.
 */
export type ChangeEvent = {
  docs: DataDoc[];
  deleted: string[];
  resync?: true;
  offline?: true;
};

export interface Collection {
  get(id: string): Promise<DataDoc | null>;
  list(opts?: { cursor?: string; limit?: number }): Promise<Page<DataDoc>>;
  query(q: DataQueryInput): Promise<QueryPage>;
  set(id: string, data: unknown): Promise<DataDoc>;
  update(id: string, patch: Record<string, unknown>): Promise<DataDoc>;
  delete(id: string): Promise<void>;
  /** Live changes; refetch your data when `e.resync` is true (after a reconnect);
   *  `e.offline` means live changes are paused until the next resync.
   *  `onReady` runs once the shell has acknowledged the subscription, so callers
   *  can wait for live delivery to be armed before depending on it. */
  subscribe(
    cb: (e: ChangeEvent) => void,
    opts?: { onReady?: () => void },
  ): () => void;
}

export interface OpenArtifacts {
  /** Resolves on the shell's `welcome` (at once in the raw view). */
  ready: Promise<void>;
  viewer: {
    /** The signed-in viewer, or null (anonymous viewers included). */
    get(): Promise<Viewer | null>;
    /**
     * An anonymous viewer's per-artifact id (their docs' updatedBy
     * "anon:<anonId>") on an artifact that allows anonymous writes; null
     * otherwise, signed-in viewers included. Per browser, resettable, a label
     * and not an account or a permission.
     */
    anonId(): Promise<string | null>;
  };
  db: { collection(name: string): Collection };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, v: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    /** The viewer's keys, up to the first STORAGE_LIST_MAX. */
    list(): Promise<string[]>;
  };
  theme: Theme;
  onTheme(cb: (t: Theme) => void): () => void;
}

declare global {
  interface Window {
    openArtifacts?: OpenArtifacts;
  }
}

/** Lazy chunk URLs (relative to the runtime script), set at build time. */
declare const __OA_SNAPSHOT__: string | undefined;
declare const __OA_SCHEMAS__: string | undefined;

export const STORAGE_LIST_MAX = 1000;
const STORAGE_PAGE = 500;
/** storage.list() never follows more than this many pages. */
const STORAGE_LIST_PAGES = 20;

type SnapshotModule = { snapshot(): Promise<string | null> };
/** A content path's artifact-version prefix: /p/<id>/v<n>/ or /c/<token>/<id>/v<n>/. */
const CONTENT_PREFIX_RE = /^\/(?:p|c\/[^/]+)\/[^/]+\/v\d+\//;

export type RuntimeOptions = {
  /** Loads the contract validators (default: the built schemas chunk). */
  loadSchemas?: () => Promise<Schemas>;
  /** Loads the snapshot chunk (default: the built snapshot chunk). */
  loadSnapshot?: () => Promise<SnapshotModule>;
  /** Aborting detaches the runtime from the window (tests). */
  signal?: AbortSignal;
  /** Whether a click came from the user (default: `isTrusted`; jsdom can't make one). */
  isTrusted?: (e: Event) => boolean;
};

const scriptSrc =
  typeof document !== "undefined" &&
  document.currentScript instanceof HTMLScriptElement
    ? document.currentScript.src
    : "";

function lazy<T>(file: string | undefined): () => Promise<T> {
  return () => {
    if (typeof file !== "string")
      return Promise.reject(new Error("chunk not built"));
    const url = new URL(file, scriptSrc || location.href).href;
    return import(/* @vite-ignore */ url) as Promise<T>;
  };
}
const SNAPSHOT =
  typeof __OA_SNAPSHOT__ === "string" ? __OA_SNAPSHOT__ : undefined;
const SCHEMAS = typeof __OA_SCHEMAS__ === "string" ? __OA_SCHEMAS__ : undefined;

/** The page's format: renderer pages carry `<meta name="oa-format">`; else html. */
function pageKind(): Format {
  const v = document
    .querySelector('meta[name="oa-format"]')
    ?.getAttribute("content");
  return v === "markdown" || v === "code" || v === "pdf" ? v : "html";
}

function systemTheme(): Theme {
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

const ignore = (e: unknown) => {
  if (
    !(
      e instanceof RuntimeError &&
      (e.code === "capability_denied" || e.code === "no_shell")
    )
  )
    console.error("openArtifacts:", e);
};

/** Cumulative scroll (px) that counts as an interaction. */
const INTERACT_EVENTS = ["pointerdown", "keydown", "input", "change"];

/**
 * Calls `fire` once, on the first pointerdown, keydown, input or change; then
 * removes every listener. Scrolling doesn't count: reading a long page must
 * not stop live versions from swapping in. Returns the remover.
 */
function onFirstInteraction(fire: () => void): () => void {
  const opts = { capture: true, passive: true };
  const done = () => {
    for (const t of INTERACT_EVENTS) removeEventListener(t, hit, opts);
  };
  function hit() {
    done();
    fire();
  }
  for (const t of INTERACT_EVENTS) addEventListener(t, hit, opts);
  return done;
}

/** Text selected, or a field (input, textarea, contenteditable) focused. */
function isEngaged(): boolean {
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim() !== "") return true;
  const el = document.activeElement;
  return (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement &&
      ![
        "button",
        "submit",
        "reset",
        "checkbox",
        "radio",
        "range",
        "color",
        "file",
        "image",
      ].includes(el.type)) ||
    (el instanceof HTMLElement &&
      (el.isContentEditable ||
        el.closest('[contenteditable]:not([contenteditable="false"])') !==
          null))
  );
}

/** How far the document can scroll. */
const maxScroll = () =>
  Math.max(0, document.documentElement.scrollHeight - innerHeight);
const SCROLL_REPORT_MS = 150;
const RESTORE_TRIES = 30;
const RESTORE_EVERY_MS = 100;

/**
 * Scrolls to where the previous version was: the same offset whenever the page
 * can scroll that far (a longer version or a reflow doesn't move the reader),
 * else the same fraction. A page not laid out yet (shorter than the offset) is
 * retried every 100 ms for up to 3 s first. Calls `done` once scrolled.
 */
function restoreScroll(
  top: number,
  max: number,
  done: () => void,
  tries = RESTORE_TRIES,
) {
  const now = maxScroll();
  if (now < top && tries > 0) {
    setTimeout(
      () => restoreScroll(top, max, done, tries - 1),
      RESTORE_EVERY_MS,
    );
    return;
  }
  scrollTo(0, now >= top ? top : max > 0 ? (top / max) * now : 0);
  done();
}

/** Builds the SDK over a fresh bridge and announces it with `hello` (html pages). */
export function createRuntime(opts: RuntimeOptions = {}): OpenArtifacts {
  const bridge: Bridge = createBridge(
    opts.loadSchemas ?? lazy<Schemas>(SCHEMAS),
  );
  const kind = pageKind();
  const themeCbs = new Set<(t: Theme) => void>();
  const subs = new Map<string, Set<(e: ChangeEvent) => void>>();
  /** One subscription ack per collection; every subscriber chains on it. */
  const ackReady = new Map<string, Promise<unknown>>();
  const queues = new Map<string, Promise<void>>();
  let welcomed: () => void = () => {};
  const ready = new Promise<void>((r) => {
    welcomed = r;
  });

  const setTheme = (t: Theme) => {
    if (api.theme === t) return;
    api.theme = t;
    for (const cb of [...themeCbs]) {
      try {
        cb(t);
      } catch (e) {
        console.error(e);
      }
    }
  };

  /**
   * Docs broadcast with data:null (over 16 KB) are refetched before delivery.
   * A failed refetch delivers `resync` instead, so the page reloads its data
   * rather than taking a doc with no data as the new value.
   */
  async function deliver(
    m: Extract<ShellToArtifact, { event: "db.change" }>,
  ): Promise<void> {
    const deleted = [...m.deleted];
    const docs: DataDoc[] = [];
    for (const d of m.docs) {
      if (d.data !== null) {
        docs.push(d);
        continue;
      }
      let fresh: DataDoc | null;
      try {
        fresh = await bridge.call("db.get", {
          collection: m.collection,
          id: d.id,
        });
      } catch {
        emit(m.collection, { docs: [], deleted: [], resync: true });
        return;
      }
      if (fresh) docs.push(fresh);
      else deleted.push(d.id);
    }
    emit(m.collection, { docs, deleted });
  }

  function emit(collection: string, e: ChangeEvent): void {
    for (const cb of [...(subs.get(collection) ?? [])]) {
      try {
        cb(e);
      } catch (err) {
        console.error(err);
      }
    }
  }

  const snapshot = async () => {
    try {
      const mod = await (opts.loadSnapshot ?? lazy<SnapshotModule>(SNAPSHOT))();
      const dataUrl = await mod.snapshot();
      if (dataUrl) bridge.send({ oa: 1, type: "thumb.ready", dataUrl });
    } catch {
      // Optional: no thumbnail.
    }
  };

  /**
   * A link that stays in this artifact version: same content origin and under
   * this document's /p/<id>/v<n>/ or /c/<token>/<id>/v<n>/ prefix (or any
   * same-origin link when this document isn't on such a path).
   */
  const ownPage = (u: URL) => {
    if (u.origin !== location.origin) return false;
    const own = CONTENT_PREFIX_RE.exec(location.pathname)?.[0];
    return !own || u.pathname.startsWith(own);
  };
  /** From the shell's welcome; until then links behave as usual. */
  let appOrigin: string | undefined;
  const trusted = opts.isTrusted ?? ((e: Event) => e.isTrusted);
  // Framed, a link to the app would load the app inside the sandboxed frame
  // (which it refuses): ask the shell to navigate the viewer instead. Any other
  // site would load in the frame too (most refuse): ask the shell to open it.
  const onClick = (e: MouseEvent) => {
    if (
      !appOrigin ||
      e.defaultPrevented ||
      e.button !== 0 ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      e.altKey ||
      !(e.target instanceof Element)
    )
      return;
    const a = e.target.closest("a[href]");
    if (!(a instanceof HTMLAnchorElement) || a.hasAttribute("download")) return;
    // No target attribute: the document's <base target>, if any.
    const t =
      a.getAttribute("target") ??
      document.querySelector("base[target]")?.getAttribute("target");
    if (t && t !== "_self") return;
    let u: URL;
    try {
      u = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (u.origin === appOrigin && NAVIGATE_PATH_RE.test(u.pathname)) {
      e.preventDefault();
      bridge.send({ oa: 1, type: "navigate", url: u.href });
      return;
    }
    // This artifact's own pages and anchors, and non-web schemes, stay as they
    // are. Everything else goes to the shell as "open": other sites open, and
    // app pages or other artifacts' content are refused there (with a note),
    // instead of loading in the frame, which they'd refuse or strand.
    if (ownPage(u) || (u.protocol !== "https:" && u.protocol !== "http:"))
      return;
    if (!trusted(e)) return;
    e.preventDefault();
    bridge.send({ oa: 1, type: "open", url: u.href });
  };

  bridge.on((m) => {
    if (m.type === "welcome") {
      appOrigin = m.appOrigin;
      setTheme(m.theme);
      welcomed();
    } else if (m.type === "theme") setTheme(m.theme);
    else if (m.type === "scroll.to") restoreScroll(m.top, m.max, onScroll);
    else if (m.type === "thumb.request") {
      if (kind === "html") void snapshot();
    } else if (m.type === "event") {
      if (!subs.has(m.collection)) return;
      const prev = queues.get(m.collection) ?? Promise.resolve();
      // Queued behind pending deliveries so a resync is never overtaken by older changes.
      const next =
        m.event === "db.resync"
          ? () => emit(m.collection, { docs: [], deleted: [], resync: true })
          : m.event === "db.offline"
            ? () => emit(m.collection, { docs: [], deleted: [], offline: true })
            : () => deliver(m);
      queues.set(m.collection, prev.then(next).catch(ignore));
    }
  });

  /**
   * Cursors of a query chain that already restarted once after
   * cursor_stale: a second cursor_stale in that chain is surfaced.
   */
  const restarted = new Set<string>();
  /**
   * db.query. On 409 cursor_stale (the doc a page ended on changed while
   * paging) it restarts once from the first page and marks that page
   * `restarted: true`, so a caller collecting pages starts over instead of
   * appending duplicates. A second cursor_stale in the same chain is thrown.
   */
  async function query(name: string, q: DataQueryInput): Promise<QueryPage> {
    const cursor = q?.cursor;
    const again = cursor !== undefined && restarted.delete(cursor);
    let page: Page<DataDoc>;
    const restart = again;
    try {
      page = await bridge.call("db.query", { collection: name, query: q });
    } catch (e) {
      if (
        again ||
        cursor === undefined ||
        !(e instanceof RuntimeError) ||
        e.code !== "cursor_stale"
      )
        throw e;
      const { cursor: _drop, ...first } = q;
      page = await bridge.call("db.query", {
        collection: name,
        query: first,
      });
      if (page.nextCursor) restarted.add(page.nextCursor);
      return { ...page, restarted: true };
    }
    if (restart && page.nextCursor) restarted.add(page.nextCursor);
    return page;
  }

  const collection = (name: string): Collection => ({
    get: (id) => bridge.call("db.get", { collection: name, id }),
    list: (o = {}) => bridge.call("db.list", { collection: name, ...o }),
    query: (q) => query(name, q),
    set: (id, data) => bridge.call("db.set", { collection: name, id, data }),
    update: (id, patch) =>
      bridge.call("db.update", { collection: name, id, patch }),
    delete: async (id) => {
      await bridge.call("db.delete", { collection: name, id });
    },
    subscribe(cb, opts) {
      let set = subs.get(name);
      if (!set) {
        set = new Set();
        subs.set(name, set);
        const mine = set;
        // One ack per collection: every caller chains on the same promise, so a
        // later subscriber's onReady can never fire before the subscription.
        const ack = bridge.call("db.subscribe", { collection: name });
        ackReady.set(name, ack);
        void ack.catch((e) => {
          // Drop the entries so the next subscribe() retries.
          if (subs.get(name) === mine) subs.delete(name);
          if (ackReady.get(name) === ack) ackReady.delete(name);
          ignore(e);
        });
      }
      set.add(cb);
      const own = set;
      let live = true;
      void ackReady.get(name)?.then(
        () => {
          if (!live) return;
          // A throwing onReady is the caller's bug: it must not reach the
          // subscribe-failure path (which would drop every live subscriber).
          try {
            opts?.onReady?.();
          } catch (e) {
            ignore(e);
          }
        },
        // The ack failed; the catch above drops the entry for a retry.
        () => {},
      );
      return () => {
        live = false;
        if (!own.delete(cb) || own.size > 0 || subs.get(name) !== own) return;
        subs.delete(name);
        ackReady.delete(name);
        bridge.call("db.unsubscribe", { collection: name }).catch(ignore);
      };
    },
  });

  const api: OpenArtifacts = {
    ready,
    viewer: {
      get: () => bridge.call("viewer.get", {}),
      anonId: () => bridge.call("viewer.anonId", {}),
    },
    db: { collection },
    storage: {
      get: (key) => bridge.call("storage.get", { key }),
      set: async (key, value) => {
        await bridge.call("storage.set", { key, value });
      },
      delete: async (key) => {
        await bridge.call("storage.delete", { key });
      },
      async list() {
        const keys: string[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let pages = 0; pages < STORAGE_LIST_PAGES; pages++) {
          const page = await bridge.call("storage.list", {
            limit: STORAGE_PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const k of page.items) keys.push(k.key);
          // Stop on the last page, an empty page, a repeated cursor, or enough keys.
          const next = page.nextCursor;
          if (
            next === null ||
            page.items.length === 0 ||
            seen.has(next) ||
            keys.length >= STORAGE_LIST_MAX
          )
            break;
          seen.add(next);
          cursor = next;
        }
        return keys.slice(0, STORAGE_LIST_MAX);
      },
    },
    theme: systemTheme(),
    onTheme(cb) {
      themeCbs.add(cb);
      return () => {
        themeCbs.delete(cb);
      };
    },
  };

  if (!bridge.raw) document.addEventListener("click", onClick, true);
  // Every format loads the runtime, so this covers renderer pages too.
  // Artifact content can forge or suppress oa:interacted: it is only a hint for
  // whether the viewer auto-swaps versions; nothing security-relevant may depend on it.
  const stopInteract = bridge.raw
    ? () => {}
    : onFirstInteraction(() => bridge.send({ oa: 1, type: "interacted" }));
  // Mid-task (a selection, a focused field): the shell holds a live swap.
  let wasEngaged = false;
  const onEngage = () => {
    const now = isEngaged();
    if (now === wasEngaged) return;
    wasEngaged = now;
    bridge.send({ oa: 1, type: "engaged", engaged: now });
  };
  // focusout fires before focus lands elsewhere: look once it has.
  const onFocusOut = () => setTimeout(onEngage, 0);
  if (!bridge.raw) {
    document.addEventListener("selectionchange", onEngage);
    addEventListener("focusin", onEngage, true);
    addEventListener("focusout", onFocusOut, true);
  }
  // Where the document is scrolled, for the shell to carry over a live swap.
  let reportTimer: ReturnType<typeof setTimeout> | undefined;
  const onScroll = () => {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = undefined;
      bridge.send({ oa: 1, type: "scroll", top: scrollY, max: maxScroll() });
    }, SCROLL_REPORT_MS);
  };
  if (!bridge.raw) {
    addEventListener("scroll", onScroll, { passive: true });
    // A resize (the side panel opening narrows the frame) reflows the page:
    // report the new max, so the next swap compares like with like.
    addEventListener("resize", onScroll, { passive: true });
  }
  opts.signal?.addEventListener("abort", () => {
    stopInteract();
    removeEventListener("scroll", onScroll);
    removeEventListener("resize", onScroll);
    document.removeEventListener("selectionchange", onEngage);
    removeEventListener("focusin", onEngage, true);
    removeEventListener("focusout", onFocusOut, true);
    clearTimeout(reportTimer);
    document.removeEventListener("click", onClick, true);
    bridge.dispose();
  });
  if (bridge.raw) welcomed();
  // Renderer pages (markdown/code/pdf) send their own hello.
  else if (kind === "html") bridge.hello(kind);
  return api;
}

if (typeof window !== "undefined" && !window.openArtifacts)
  window.openArtifacts = createRuntime();
