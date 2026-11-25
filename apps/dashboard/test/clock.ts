// A clock for the tests that need one: the shell's timers (the slow notice, the
// announce bound, a retry) and `Date.now` run on a fake clock, so a test moves
// to the moment it needs instead of waiting for the wall clock to arrive there.
// `waitFor` keeps working: the test setup gives Testing Library `jest`'s
// advanceTimersByTime, which moves this same clock (see test/setup.ts).
import { act } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/** Put this file's tests on a fake clock. Call once, at the top of the file. */
export const installClock = () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
};

/** Let queued work run up to `ms` on the clock, inside `act`. */
export const settle = async (ms = 50) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
