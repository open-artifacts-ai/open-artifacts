/**
 * The signed anonymous-id token ("<id>.<iat>.<sig>"; the legacy 2-part v1
 * "<id>.<sig>" is still accepted until the server renews it) for this browser on this
 * instance. One localStorage key on the app origin (each instance has its
 * own); with storage blocked (private mode, partitioned or disabled) it lives
 * in memory for the session. Never throws. The token stays in the shell: it is
 * never posted into the artifact frame.
 */
export const ANON_ID_KEY = "oa.anonId";
const TOKEN_RE = /^[A-Za-z0-9_-]{22}\.(?:[0-9a-z]{1,10}\.)?[A-Za-z0-9_-]{43}$/;

let memory: string | null = null;

export const isAnonToken = (v: unknown): v is string =>
  typeof v === "string" && TOKEN_RE.test(v);

export function loadAnonToken(): string | null {
  try {
    const v = localStorage.getItem(ANON_ID_KEY);
    if (isAnonToken(v)) return v;
  } catch {
    // Storage blocked: fall back to memory.
  }
  return memory;
}

export function saveAnonToken(token: string): void {
  if (!isAnonToken(token)) return;
  memory = token;
  try {
    localStorage.setItem(ANON_ID_KEY, token);
  } catch {
    // Storage blocked: memory only.
  }
}

/** The Web Lock every tab of this browser takes to mint a token. */
export const MINT_LOCK = "oa.anonId.mint";

/**
 * How long a minting tab keeps MINT_LOCK after its call settles: storage
 * reaches other tabs asynchronously (WebKit), and a waiter must see the token.
 */
export const MINT_SETTLE_MS = 300;

/**
 * Runs `fn` (a call that mints a token) holding MINT_LOCK, so tabs opened at
 * once mint one token between them: each waiter re-reads the token inside the
 * lock and finds the first tab's. `fn`'s result is returned as soon as it
 * settles; the lock is held MINT_SETTLE_MS longer. Without Web Locks (or if
 * the lock can't be taken) it runs `fn` directly. Rejects with AbortError
 * when `signal` aborts while waiting.
 */
export function withMintLock<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return fn();
  return new Promise<T>((resolve, reject) => {
    let ran = false;
    locks
      .request(MINT_LOCK, signal ? { signal } : {}, async () => {
        ran = true;
        await fn().then(resolve, reject);
        await new Promise((r) => setTimeout(r, MINT_SETTLE_MS));
      })
      .catch((e: unknown) => {
        if (ran) return;
        if (signal?.aborted) reject(e);
        else fn().then(resolve, reject);
      });
  });
}

/**
 * viewer.anonId() results, so a reload doesn't ask the server again (its
 * anon-id route is rate limited per IP, #681). Keyed by the token's id part
 * (a renewed token keeps it) and the artifact; a new id starts over.
 */
export const ANON_SHORT_KEY = "oa.anonShort";
const SHORTS_MAX = 200;
type Shorts = { id: string; by: Record<string, string> };
let shortsMemory: Shorts | null = null;
const idPart = (token: string) => token.slice(0, 22);

function loadShorts(): Shorts | null {
  try {
    const v = JSON.parse(localStorage.getItem(ANON_SHORT_KEY) ?? "null");
    if (
      v &&
      typeof v.id === "string" &&
      v.by &&
      typeof v.by === "object" &&
      !Array.isArray(v.by)
    )
      return v as Shorts;
  } catch {
    // Storage blocked or bad JSON: fall back to memory.
  }
  return shortsMemory;
}

/** The cached anonId for `artifactId` under `token`'s id, or null. */
export function loadAnonShort(token: string | null, artifactId: string) {
  if (!token) return null;
  const s = loadShorts();
  const v = s?.id === idPart(token) ? s.by[artifactId] : undefined;
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

export function saveAnonShort(
  token: string | null,
  artifactId: string,
  short: string,
): void {
  if (!token) return;
  const prev = loadShorts();
  const by = prev?.id === idPart(token) ? { ...prev.by } : {};
  delete by[artifactId];
  by[artifactId] = short;
  const keys = Object.keys(by);
  for (const k of keys.slice(0, Math.max(0, keys.length - SHORTS_MAX)))
    delete by[k];
  shortsMemory = { id: idPart(token), by };
  try {
    localStorage.setItem(ANON_SHORT_KEY, JSON.stringify(shortsMemory));
  } catch {
    // Storage blocked: memory only.
  }
}

/** Tests only. */
export const resetAnonMemory = () => {
  memory = null;
  shortsMemory = null;
};
