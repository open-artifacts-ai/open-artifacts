import { type ArtifactSummary, viewerPath } from "@oa/shared";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { FullGone } from "./LiveChip";

/** The pointer counts as near the group within this many px of it. */
export const NEAR_PX = 80;
/** pointermove is handled at most this often. */
const THROTTLE_MS = 50;

const embedded = () => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // A cross-origin parent throws on access.
  }
};

/** Tooltip on hover and keyboard focus; the control keeps its own name. */
export function FsTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="end" collisionPadding={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** The full-screen view's controls (#2189): one compact group floating at the
    top right, over the artifact. Comments (`live`, with the new-version pill)
    then Exit. Embedded, Exit opens the viewer in a new tab instead. It rests
    at 55% opacity and is solid on hover, focus within, or a pointer within
    NEAR_PX; it never hides or moves. `gone` swaps Exit for "No longer
    available". */
export function FullScreenEscape({
  artifact,
  live,
  gone = false,
}: {
  artifact: ArtifactSummary;
  live?: ReactNode;
  gone?: boolean;
}) {
  const [inFrame] = useState(embedded);
  const [near, setNear] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const to = viewerPath(artifact.id);

  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = (x: number, y: number) => {
      const r = bar.current?.getBoundingClientRect();
      if (!r) return;
      setNear(
        x >= r.left - NEAR_PX &&
          x <= r.right + NEAR_PX &&
          y >= r.top - NEAR_PX &&
          y <= r.bottom + NEAR_PX,
      );
    };
    // Throttled, with a trailing call so the last position always lands.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      clearTimeout(timer);
      const wait = last + THROTTLE_MS - Date.now();
      if (wait <= 0) {
        last = Date.now();
        measure(e.clientX, e.clientY);
      } else {
        timer = setTimeout(() => {
          last = Date.now();
          measure(e.clientX, e.clientY);
        }, wait);
      }
    };
    const onLeave = () => {
      clearTimeout(timer);
      setNear(false);
    };
    document.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  useEffect(() => {
    if (inFrame) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) void navigate({ to });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inFrame, navigate, to]);

  const label = inFrame ? "Open in Open Artifacts" : "Exit full screen";
  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="oa-fsbar"
        ref={bar}
        data-near={near}
        // The artifact's frame swallows pointer events, so leaving the group
        // into it is the last signal the top document gets.
        onPointerLeave={() => setNear(false)}
      >
        {live}
        {gone ? (
          <FullGone id={artifact.id} embed={inFrame} />
        ) : (
          <FsTip label={label}>
            <Link
              to={to}
              {...(inFrame ? { target: "_blank", rel: "noopener" } : {})}
              className="oa-fsx"
              aria-label={
                inFrame
                  ? `Open ${artifact.title} in Open Artifacts (opens in new tab)`
                  : `Exit full screen, back to ${artifact.title}`
              }
            >
              {inFrame ? (
                <ArrowUpRight className="oa-fsicon" aria-hidden="true" />
              ) : (
                <X className="oa-fsicon" aria-hidden="true" />
              )}
            </Link>
          </FsTip>
        )}
      </div>
    </TooltipProvider>
  );
}
