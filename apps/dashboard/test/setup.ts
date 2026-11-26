import "@testing-library/jest-dom/vitest";
import { toast } from "@oa/ui/shadcn";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(cleanup);

// waitFor and findBy poll for state; 1 s (the default) is too short on a
// loaded CI runner. Tests that need a tighter bound pass their own timeout.
configure({ asyncUtilTimeout: 5_000 });

// A test that puts the suite on a fake clock (`vi.useFakeTimers`) can still use
// waitFor: when it detects fake timers, Testing Library advances them through
// the `jest` global, which vitest does not define. Give it one that advances
// vitest's clock, so a poll on a fake clock is a poll on that clock.
(globalThis as unknown as { jest?: unknown }).jest = {
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
};

// jsdom has no matchMedia; the shadcn sidebar asks for the phone breakpoint.
if (!window.matchMedia)
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

// jsdom has no scrollIntoView; Radix Select scrolls the chosen item into view.
if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};

// Sonner keeps toasts in module state; start each test with none.
afterEach(() => {
  toast.dismiss();
});
