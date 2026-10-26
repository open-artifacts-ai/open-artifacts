import {
  type ArtifactToShell,
  type ErrorCode,
  type Format,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
  type ShellToArtifact,
  shellNonce,
} from "@oa/shared";

export const CALL_TIMEOUT_MS = 15_000;
/** Framed, before any shell message: a call waiting this long rejects with no_shell. */
export const HANDSHAKE_MS = 3_000;
export const RAW_VIEW_MESSAGE =
  "Open this artifact in Open Artifacts to use live data";
/** console.warn text, once per load, on the first anon_writes_disabled (#681). */
export const ANON_WRITES_WARN =
  "this artifact doesn't allow anonymous writes; publish it with allowAnonymousWrites: true to let anonymous visitors write";

/** API error codes, plus `no_shell`: no viewer shell to reach the server. */
export type RuntimeErrorCode = ErrorCode | "no_shell";

/** Rejection value of every runtime call: `{ code, message }` (an Error). */
export class RuntimeError extends Error {
  constructor(
    public code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

/** The lazily loaded validators (src/schemas.ts). */
export type Schemas = typeof import("./schemas.js");

type Pending = {
  method: RuntimeMethod;
  resolve: (v: unknown) => void;
  reject: (e: RuntimeError) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The handshake bound, set while no shell message has arrived. */
  hs?: ReturnType<typeof setTimeout>;
};

export type Listener = (m: ShellToArtifact) => void;

export interface Bridge {
  /** True in the raw view (no parent shell): every call rejects with no_shell. */
  readonly raw: boolean;
  /** This load's nonce from the frame URL (`#oa=`), sent on every message. */
  readonly nonce: string | undefined;
  call<M extends RuntimeMethod>(
    method: M,
    params: RuntimeParams<M>,
  ): Promise<RuntimeResult<M>>;
  /** Shell messages other than `result` (welcome, event, theme, thumb.request). */
  on(l: Listener): () => void;
  /** Posts to the shell once the contract chunk is loaded (no-op in raw view). */
  send(msg: ArtifactToShell): void;
  hello(kind: Format): void;
  dispose(): void;
}

let counter = 0;
const newCallId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `c${++counter}-${Date.now()}`;
  }
};

/**
 * postMessage link to the parent shell. Only messages whose source is
 * `window.parent` and that parse (parseShellMessage) are accepted, in arrival
 * order; params and results are validated with RUNTIME_PARAMS / RUNTIME_RESULTS.
 * Every message to the shell carries the per-load nonce read (and stripped) from
 * location.hash at boot. Framed without one, the shell drops our messages, so
 * calls go unanswered and fail with no_shell after HANDSHAKE_MS.
 */
export function createBridge(loadSchemas: () => Promise<Schemas>): Bridge {
  const win = window;
  const raw = win.parent === win;
  // Read now, before any artifact script runs or the hash changes.
  const nonce = shellNonce();
  /** Set by the first shell message; a late shell is still accepted. */
  let shell = false;
  /** The first anon_writes_disabled refusal has been logged. */
  let anonWarned = false;
  const noShell = () => new RuntimeError("no_shell", RAW_VIEW_MESSAGE);
  const pending = new Map<string, Pending>();
  const listeners = new Set<Listener>();
  const schemas: Promise<Schemas | null> = raw
    ? Promise.resolve(null)
    : loadSchemas().catch((e) => {
        console.error("openArtifacts: runtime failed to load", e);
        return null;
      });
  let inbox: Promise<unknown> = schemas;
  const settle = (id: string): Pending | undefined => {
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      clearTimeout(p.timer);
      clearTimeout(p.hs);
    }
    return p;
  };

  const handle = (s: Schemas | null, data: unknown) => {
    const m = s?.parseShellMessage(data);
    if (!s || !m) return;
    shell = true;
    if (m.type !== "result") {
      for (const l of [...listeners]) {
        try {
          l(m);
        } catch (err) {
          console.error(err);
        }
      }
      return;
    }
    const p = settle(m.id);
    if (!p) return;
    if (!m.ok) {
      // #681: tell the page's author once per load, not on every refusal.
      if (m.error.code === "anon_writes_disabled" && !anonWarned) {
        anonWarned = true;
        console.warn(`openArtifacts: ${ANON_WRITES_WARN}`);
      }
      return p.reject(new RuntimeError(m.error.code, m.error.message));
    }
    const r = s.RUNTIME_RESULTS[p.method].safeParse(m.value);
    if (r.success) p.resolve(r.data);
    else p.reject(new RuntimeError("internal", "invalid response from shell"));
  };

  const onMessage = (e: MessageEvent) => {
    if (raw || e.source !== win.parent) return;
    const data: unknown = e.data;
    inbox = inbox.then(() => schemas).then((s) => handle(s, data));
  };
  win.addEventListener("message", onMessage);

  const post = (s: Schemas, msg: ArtifactToShell) =>
    s.sendToShell(nonce ? { ...msg, nonce } : msg);
  const send = (msg: ArtifactToShell) => {
    void schemas.then((s) => s && post(s, msg));
  };

  return {
    raw,
    nonce,
    call(method, params) {
      if (raw) return Promise.reject(noShell());
      const id = newCallId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RuntimeError("internal", "shell did not respond"));
        }, CALL_TIMEOUT_MS);
        pending.set(id, {
          method,
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
          hs: shell
            ? undefined
            : setTimeout(() => {
                if (!shell) settle(id)?.reject(noShell());
              }, HANDSHAKE_MS),
        });
        const fail = (code: ErrorCode, message: string) =>
          settle(id)?.reject(new RuntimeError(code, message));
        void schemas.then((s) => {
          if (!pending.has(id)) return;
          if (!s) return fail("internal", "runtime failed to load");
          const parsed = s.RUNTIME_PARAMS[method].safeParse(params);
          if (!parsed.success)
            return fail("bad_request", `invalid params for ${method}`);
          try {
            post(s, { oa: 1, type: "call", id, method, params: parsed.data });
          } catch {
            // DataCloneError: params that postMessage cannot copy.
            fail("bad_request", "params are not cloneable");
          }
        });
      });
    },
    on(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    send,
    hello(kind) {
      void schemas.then(
        (s) =>
          s &&
          post(s, { oa: 1, type: "hello", protocol: s.PROTOCOL_VERSION, kind }),
      );
    },
    dispose() {
      win.removeEventListener("message", onMessage);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        clearTimeout(p.hs);
      }
      pending.clear();
      listeners.clear();
    },
  };
}
