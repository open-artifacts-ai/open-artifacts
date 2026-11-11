import { type ArtifactSummary, viewerPath } from "@oa/shared";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { FullGone } from "./LiveChip";

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
    then Exit. Embedded, Exit opens the viewer in a new tab instead. The surface
    is always solid; the icons are muted at rest and full contrast on hover or
    focus within. It never hides or moves. `gone` swaps Exit for "No longer
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
  const navigate = useNavigate();
  const to = viewerPath(artifact.id);

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
      <div className="oa-fsbar">
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
