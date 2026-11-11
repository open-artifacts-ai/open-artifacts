// Shared shadcn pieces for the artifact detail chrome (title bar, panels, diff).
import type { Visibility } from "@oa/shared";
import { Badge, cn } from "@oa/ui/shadcn";

/** The app's 13px chrome text size. */
export const TXT = "text-[length:var(--oa-text-sm)]";
/** Chrome buttons are xs (24px); below 600px they grow to 32px to tap. */
export const SM = `${TXT} max-[600px]:h-8 max-[600px]:px-3`;
/** Title bar buttons: 32px with 14px text on every width (#2118). */
export const BAR = "text-[length:var(--oa-text-md)] h-8 px-3";
/** Icon-only buttons grow the same way. */
export const ICON = "max-[600px]:size-8";
/** A link rendered as a shadcn button: no underline, the button's own color. */
export const LINK_BTN = `${SM} text-foreground hover:text-accent-foreground`;

const VIS: Record<Visibility, { label: string; tone: string; icon: string[] }> =
  {
    private: {
      label: "Private",
      tone: "bg-[var(--oa-sunken)] text-[var(--oa-text-2)]",
      icon: [
        "M4.5 7h7A1.5 1.5 0 0 1 13 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5v-4A1.5 1.5 0 0 1 4.5 7zM5.5 7V5a2.5 2.5 0 0 1 5 0v2",
      ],
    },
    team: {
      label: "Team",
      tone: "bg-[var(--oa-accent-soft)] text-[var(--oa-accent-fg)]",
      icon: [
        "M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM1.5 13.5c.5-2.5 2.3-3.8 4.5-3.8s4 1.3 4.5 3.8M11 3.8a2.3 2.3 0 0 1 0 4.4M12.5 10c1.2.6 1.8 1.8 2 3.5",
      ],
    },
    public: {
      label: "Public",
      tone: "bg-[var(--oa-success-soft)] text-[var(--oa-success-fg)]",
      icon: [
        "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c1.8 2 2.6 4 2.6 6S9.8 12 8 14M8 2C6.2 4 5.4 6 5.4 8S6.2 12 8 14",
      ],
    },
  };

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  const v = VIS[visibility];
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-[18px] gap-1 rounded-sm px-[6px] py-0 text-[length:var(--oa-text-xs)]",
        v.tone,
      )}
    >
      <svg
        viewBox="0 0 16 16"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {v.icon.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      {v.label}
    </Badge>
  );
}
