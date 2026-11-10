import { LIMITS } from "@oa/shared";
import { toCanvas } from "html-to-image";

export const WIDTH = 1200;
export const HEIGHT = 750;
const PREFIX = "data:image/webp;base64,";
const QUALITIES = [0.8, 0.6, 0.45, 0.3, 0.15];

/** Decoded size of a base64 data URL's payload. */
export function base64Bytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** How long the page must load nothing new before the snapshot, and the cap on waiting. */
export const SETTLE = { quietMs: 500, maxMs: 5_000, stepMs: 100 } as const;

export type SettleProbe = {
  /** The document's load event has fired. */
  loaded(): boolean;
  /** Every <img> has finished (loaded or failed). */
  imagesDone(): boolean;
  /** How many resources the page has fetched so far. */
  resources(): number;
  now(): number;
  sleep(ms: number): Promise<void>;
};

const domProbe: SettleProbe = {
  loaded: () => document.readyState === "complete",
  imagesDone: () => Array.from(document.images).every((i) => i.complete),
  resources: () => performance.getEntriesByType?.("resource").length ?? 0,
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Waits until the page has loaded what it shows: the load event, every image
 * done and no new resource for SETTLE.quietMs. Never longer than SETTLE.maxMs.
 * The thumbnail is asked for when the runtime starts, before a page that adds
 * images later (map tiles, avatars) has drawn them.
 */
export async function settle(p: SettleProbe = domProbe): Promise<void> {
  const end = p.now() + SETTLE.maxMs;
  let count = -1;
  let quietSince = p.now();
  while (p.now() < end) {
    const n = p.resources();
    if (n !== count) {
      count = n;
      quietSince = p.now();
    }
    if (p.loaded() && p.imagesDone() && p.now() - quietSince >= SETTLE.quietMs)
      return;
    await p.sleep(SETTLE.stepMs);
  }
}

/**
 * The page (document.documentElement) as a 1200×750 webp data URL no larger
 * than LIMITS.thumbnailBytes, lowering quality until it fits; null otherwise.
 * It waits for the page to settle first. A viewport wider than 1200 is drawn
 * at its own width and scaled down, so the thumbnail shows what a viewer sees.
 */
export async function snapshot(): Promise<string | null> {
  await settle();
  const bg = getComputedStyle(
    document.body ?? document.documentElement,
  ).backgroundColor;
  const width = Math.max(WIDTH, document.documentElement.clientWidth || 0);
  const height = Math.round((width * HEIGHT) / WIDTH);
  const canvas = await toCanvas(document.documentElement, {
    width,
    height,
    canvasWidth: WIDTH,
    canvasHeight: HEIGHT,
    pixelRatio: 1,
    backgroundColor:
      bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" ? bg : "#ffffff",
  });
  for (const q of QUALITIES) {
    const url = canvas.toDataURL("image/webp", q);
    if (!url.startsWith(PREFIX)) return null; // no webp encoder
    if (base64Bytes(url) <= LIMITS.thumbnailBytes) return url;
  }
  return null;
}
