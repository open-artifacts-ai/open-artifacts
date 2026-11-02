import "@testing-library/jest-dom/vitest";
import { toast } from "@oa/ui/shadcn";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// waitFor and findBy poll for state; 1 s (the default) is too short on a
// loaded CI runner. Tests that need a tighter bound pass their own timeout.
configure({ asyncUtilTimeout: 5_000 });

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

// jsdom has no ResizeObserver; the Radix Checkbox measures itself with one.
if (!("ResizeObserver" in globalThis))
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

// Sonner keeps toasts in module state; start each test with none.
afterEach(() => {
  toast.dismiss();
});
