import { ARTIFACT_SANDBOX_ATTR, withShellNonce } from "@oa/shared";

/**
 * Artifacts are untrusted. One token list, shared with the content host's CSP
 * (the browser applies only their intersection): popups escape the sandbox so
 * links out open as normal tabs; never allow-same-origin or top navigation.
 */
export const SANDBOX = ARTIFACT_SANDBOX_ATTR;

/** Same-origin content is limited to the server's versioned content routes, never app pages. */
export const safeContentUrl = (u: string | null) => {
  if (!u) return null;
  try {
    const p = new URL(u);
    return (p.protocol === "https:" || p.protocol === "http:") &&
      !p.username &&
      !p.password &&
      (p.origin !== location.origin ||
        /^\/(?:c\/[^/]+\/|p\/)[^/]+\/v[1-9]\d*\/.+/.test(p.pathname))
      ? u
      : null;
  } catch {
    return null;
  }
};

/** 16 random bytes, base64url without padding (22 characters). */
export function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export type FrameLoad = {
  /** The nonce the frame's runtime sends on every message. */
  nonce: string;
  /** True from our src assignment until its `load` event. */
  expected: boolean;
};

const loads = new WeakMap<HTMLIFrameElement, FrameLoad>();

/** The current intentional load of `iframe` (set only by loadArtifactFrame). */
export const frameLoad = (iframe: HTMLIFrameElement) => loads.get(iframe);

/**
 * The only way to point an artifact iframe at content: mints a fresh nonce,
 * marks the next `load` as ours and sets src to `url#oa=<nonce>`. Never set an
 * artifact iframe's src (or the JSX `src` prop) any other way: the bridge
 * accepts only messages carrying the current nonce, and treats a `load` it
 * didn't expect as a renavigation and disposes itself.
 */
export function loadArtifactFrame(
  iframe: HTMLIFrameElement,
  url: string,
): FrameLoad {
  const l: FrameLoad = { nonce: newNonce(), expected: true };
  loads.set(iframe, l);
  iframe.src = withShellNonce(url, l.nonce);
  return l;
}
