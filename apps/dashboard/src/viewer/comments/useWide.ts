import { useSyncExternalStore } from "react";

/** 960px and up: the margin column, and the wide side panel. */
export const WIDE = "(min-width: 960px)";

/** 960px and up (true where there is no matchMedia, as the surface hook does). */
export const useWide = () =>
  useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.(WIDE);
      m?.addEventListener?.("change", cb);
      return () => m?.removeEventListener?.("change", cb);
    },
    () => window.matchMedia?.(WIDE).matches ?? false,
    () => true,
  );
