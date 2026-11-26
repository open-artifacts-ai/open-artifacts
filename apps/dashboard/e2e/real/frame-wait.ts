// Waiting for a frame on a daemon socket (bus-confirm.ts openAgent,
// agent-requests-2577.spec.ts). Each wait is bounded by withDeadline and, when
// the bound passes, takes its waiter out of the queue: a dead waiter would
// otherwise swallow the next frame (or be called for nothing) in a later wait.
import { withDeadline } from "../staging/with-deadline";

/** How long a frame may take before the wait fails by name. */
export const FRAME_WAIT_MS = 15_000;

/**
 * The next frame that matches, taken out of `frames` (a frame already queued
 * counts). Frames that arrive while it waits go to the first waiter, which
 * puts itself back when the frame is not the one it wants.
 */
export function takeFrame<F>(
  frames: F[],
  waiters: ((f: F) => void)[],
  match: (f: F) => boolean,
  label: string,
  ms = FRAME_WAIT_MS,
  deadline: typeof withDeadline = withDeadline,
): Promise<F> {
  let take: (f: F) => void = () => {};
  const found = new Promise<F>((resolve) => {
    take = (f) => {
      if (match(f)) resolve(f);
      else waiters.push(take);
    };
    const q = frames.findIndex(match);
    if (q >= 0) resolve(frames.splice(q, 1)[0] as F);
    else waiters.push(take);
  });
  return deadline(found, ms, label).catch((e) => {
    const i = waiters.indexOf(take);
    if (i >= 0) waiters.splice(i, 1);
    throw e;
  });
}

/**
 * The first frame in `frames` that matches, left in place; `waiters` are woken
 * on every new frame and re-check.
 */
export function findFrame<F>(
  frames: F[],
  waiters: (() => void)[],
  match: (f: F) => boolean,
  label: string,
  ms = FRAME_WAIT_MS,
  deadline: typeof withDeadline = withDeadline,
): Promise<F> {
  let onMsg: () => void = () => {};
  const found = new Promise<F>((resolve) => {
    const check = () => {
      const f = frames.find(match);
      if (!f) return false;
      resolve(f);
      return true;
    };
    onMsg = () => {
      if (!check()) waiters.push(onMsg);
    };
    if (!check()) waiters.push(onMsg);
  });
  return deadline(found, ms, label).catch((e) => {
    const i = waiters.indexOf(onMsg);
    if (i >= 0) waiters.splice(i, 1);
    throw e;
  });
}
