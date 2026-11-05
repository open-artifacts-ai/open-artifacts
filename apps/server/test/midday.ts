import { vi } from "vitest";

/**
 * Fakes only Date, pinned to 12:00 UTC today and still advancing, so a test
 * that seeds today's day bucket and the server that reads its own Date.now()
 * agree even if the run crosses 00:00 UTC. Timers stay real. Undo with
 * vi.useRealTimers().
 */
export function pinMiddayUtc(): number {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(d);
  return d.getTime();
}
