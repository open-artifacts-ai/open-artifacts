import { type ArtifactSummary, viewerPath } from "@oa/shared";
import { brand } from "@oa/ui/brand";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { FullGone } from "./LiveChip";

/** Widened on load this long, then it collapses (top level only). */
export const REVEAL_MS = 3_000;
/** Collapses this long after the pointer leaves or focus moves. */
export const LINGER_MS = 400;
/** A first tap on a coarse pointer widens it this long. */
export const TAP_MS = 4_000;

const embedded = () => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // A cross-origin parent throws on access.
  }
};
const coarse = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;
const focusVisible = (el: Element) => {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
};

/** The full-screen view's way back (#290, option A): a small floating toolbar
    at the top right. Embedded, it opens the viewer in a new tab instead.
    `live` (the new-version pill) sits 8px to its left and precedes it in tab
    order; `gone` turns the chip into "No longer available". */
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
  const [open, setOpen] = useState(!inFrame);
  const held = useRef({ hover: false, focus: false });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const navigate = useNavigate();
  const to = viewerPath(artifact.id);

  const widen = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  const collapseIn = (ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!held.current.hover && !held.current.focus) setOpen(false);
    }, ms);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on load
  useEffect(() => {
    if (!inFrame) collapseIn(REVEAL_MS);
    return () => clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (inFrame) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) void navigate({ to });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inFrame, navigate, to]);

  return (
    <div className="oa-fsbar">
      {live}
      {gone ? (
        <FullGone id={artifact.id} embed={inFrame} />
      ) : (
        <Link
          to={to}
          {...(inFrame ? { target: "_blank", rel: "noopener" } : {})}
          className="oa-fsx"
          data-open={open}
          aria-label={
            inFrame
              ? `Open ${artifact.title} in Open Artifacts (opens in new tab)`
              : `Exit full screen, back to ${artifact.title}`
          }
          onPointerEnter={(e) => {
            if (e.pointerType === "touch") return;
            held.current.hover = true;
            widen();
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "touch") return;
            held.current.hover = false;
            collapseIn(LINGER_MS);
          }}
          onFocus={(e) => {
            if (!focusVisible(e.currentTarget)) return;
            held.current.focus = true;
            widen();
          }}
          onBlur={() => {
            held.current.focus = false;
            collapseIn(LINGER_MS);
          }}
          onClick={(e) => {
            if (open || !coarse()) return;
            e.preventDefault();
            widen();
            collapseIn(TAP_MS);
          }}
        >
          <img
            src={brand.markDark}
            alt=""
            aria-hidden="true"
            width={18}
            height={18}
          />
          <span className="oa-fsx-label">
            {inFrame ? "Open in Open Artifacts" : "Exit full screen"}
          </span>
          {inFrame && (
            <ArrowUpRight className="oa-fsx-arrow" aria-hidden="true" />
          )}
        </Link>
      )}
    </div>
  );
}
