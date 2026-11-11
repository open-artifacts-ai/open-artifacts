import { type ArtifactSummary, viewerPath } from "@oa/shared";
import { brand } from "@oa/ui/brand";
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
/** The full-screen view's way back (#2112, option B): a 36px strip above the
    frame, never over it. The title is on the left; on the right `live` (the
    new-version pill and Comments) precedes the exit link in tab order.
    Embedded, the link opens the viewer in a new tab instead. `gone` turns the
    link into "No longer available". */
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

  return (
    <div className="oa-fsbar">
      <span className="oa-fstitle" title={artifact.title}>
        {artifact.title}
      </span>
      <div className="oa-fsactions">
        {live}
        {gone ? (
          <FullGone id={artifact.id} embed={inFrame} />
        ) : (
          <Link
            to={to}
            {...(inFrame ? { target: "_blank", rel: "noopener" } : {})}
            className="oa-fsx"
            aria-label={
              inFrame
                ? `Open ${artifact.title} in Open Artifacts (opens in new tab)`
                : "Exit full screen"
            }
          >
            {inFrame && (
              <>
                <img
                  className="oa-fsx-lt"
                  src={brand.markLight}
                  alt=""
                  aria-hidden="true"
                  width={18}
                  height={18}
                />
                <img
                  className="oa-fsx-dk"
                  src={brand.markDark}
                  alt=""
                  aria-hidden="true"
                  width={18}
                  height={18}
                />
              </>
            )}
            <span className="oa-fsx-label">
              {inFrame ? "Open in Open Artifacts" : "Exit full screen"}
            </span>
            {inFrame ? (
              <ArrowUpRight className="oa-fsx-arrow" aria-hidden="true" />
            ) : (
              <X className="oa-fsx-x" aria-hidden="true" />
            )}
          </Link>
        )}
      </div>
    </div>
  );
}
