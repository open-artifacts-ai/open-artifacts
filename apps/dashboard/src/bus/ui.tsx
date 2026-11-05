// #1293: pieces the bus pages share.
import { Badge, cn } from "@oa/ui/shadcn";

export const LIVE_DOWN =
  "Live status isn't available right now. Reload to try again.";
export const QUEUE_LEGEND =
  "Live agents receive at once. Queued agents get messages if their machine reconnects within 1 hour; after that the sender is told it expired.";
/** Where a machine is approved: the server page the terminal prints (#1291). */
export const APPROVE_PATH = "/bus/approve";

const TONE = {
  Live: "bg-[var(--oa-success-soft)] text-[var(--oa-success-fg)]",
  Queued: "bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]",
  Offline: "bg-secondary text-muted-foreground",
  Unknown: "bg-secondary text-muted-foreground",
  Revoked: "bg-secondary text-muted-foreground",
} as const;
export type Status = keyof typeof TONE;

/** A dot plus a word: never colour alone. */
export function StatusBadge({
  status,
  text,
}: {
  status: Status;
  text?: string;
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-[20px] gap-[5px] rounded-full px-[8px] py-0 text-[length:var(--oa-text-xs)] font-medium",
        TONE[status],
      )}
    >
      <span aria-hidden="true" className="size-[7px] rounded-full bg-current" />
      {text ?? status}
    </Badge>
  );
}

/** "1 live agent", "2 live agents". */
export const liveAgents = (n: number) => `${n} live agent${n === 1 ? "" : "s"}`;
