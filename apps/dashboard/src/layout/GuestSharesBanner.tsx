// Parity 2 (decision A6, Manager's ruling of 2026-10-28): guests are view-only
// on every install. On Access-only installs, each member sees once which guest
// editor shares on their own artifacts changed, and the org owner sees an
// install-wide summary (counts only) with the guests who own artifacts, each
// with Transfer. Each notice is dismissed for good (R.noticeDismiss).
import type { GuestOwner, Me, Member } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { qk, useDismissNotice } from "../api/queries";
import { AppLink } from "../library/AppLink";
import { TransferDialog } from "../settings/Transfer";
import { Notice } from "./Notice";

const LIST = "m-0 grid max-h-[220px] gap-[2px] overflow-auto pl-[18px]";
const n = (k: number, one: string, many: string) =>
  `${k} ${k === 1 ? one : many}`;

export function GuestSharesBanner({
  me,
  className = "",
}: {
  me: Me | null | undefined;
  /** The page's content column, so the banner's edges line up with it. */
  className?: string;
}) {
  const shares = me?.notices?.guestShares;
  const summary = me?.notices?.guestSummary;
  if (!shares?.items.length && !summary) return null;
  return (
    <div
      className={`mb-[var(--oa-space-3)] grid gap-[var(--oa-space-2)] ${className}`}
    >
      {summary && <SummaryNotice summary={summary} />}
      {shares && shares.items.length > 0 && <SharesNotice shares={shares} />}
    </div>
  );
}

function SharesNotice({
  shares,
}: {
  shares: NonNullable<NonNullable<Me["notices"]>["guestShares"]>;
}) {
  const dismiss = useDismissNotice();
  return (
    <Notice
      tone="info"
      title="Guests can now only view"
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate("guest_shares")}
        >
          Got it
        </Button>
      }
    >
      <p>
        Guests had edit access to these artifacts of yours. It now works as
        view-only. To let someone edit, ask an admin to make them a member.
      </p>
      <ul aria-label="Your shares that became view-only" className={LIST}>
        {shares.items.map((i) => (
          <li key={`${i.artifactId}:${i.guestEmail}`} className="break-words">
            <AppLink
              href={`/a/${i.artifactId}`}
              className="underline underline-offset-2"
            >
              {i.title}
            </AppLink>{" "}
            · {i.guestEmail}
          </li>
        ))}
      </ul>
      {shares.more && (
        <p>Plus others not listed here. Check Share on your artifacts.</p>
      )}
    </Notice>
  );
}

function SummaryNotice({
  summary,
}: {
  summary: NonNullable<NonNullable<Me["notices"]>["guestSummary"]>;
}) {
  const dismiss = useDismissNotice();
  const qc = useQueryClient();
  const [moving, setMoving] = useState<GuestOwner | null>(null);
  return (
    <Notice
      tone="info"
      title="Guests can now only view, everywhere on this instance"
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate("guest_summary")}
        >
          Got it
        </Button>
      }
    >
      {summary.shares > 0 && (
        <p>
          {n(summary.shares, "guest share", "guest shares")} with edit access,
          on {n(summary.owners, "person's", "people's")} artifacts, now work as
          view-only. Each of those people sees their own list.
        </p>
      )}
      {summary.guestOwners.length > 0 && (
        <>
          <p>
            These guests own artifacts they can no longer edit. You can move
            them to a member.
          </p>
          <ul
            aria-label="Guests who own artifacts"
            className="m-0 grid gap-[4px] p-0"
          >
            {summary.guestOwners.map((g) => (
              <li
                key={g.userId}
                className="flex flex-wrap items-center gap-x-[var(--oa-space-2)] gap-y-[2px]"
              >
                <span className="min-w-0 break-words">
                  {g.email} · {n(g.artifacts, "artifact", "artifacts")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Transfer ${g.email}'s artifacts`}
                  onClick={() => setMoving(g)}
                >
                  Transfer their artifacts
                </Button>
              </li>
            ))}
          </ul>
          {summary.more && <p>Plus other guests who own artifacts.</p>}
        </>
      )}
      {moving && (
        <TransferDialog
          member={asMember(moving)}
          onClose={() => {
            setMoving(null);
            // The summary's counts come from /me.
            void qc.invalidateQueries({ queryKey: qk.me });
          }}
        />
      )}
    </Notice>
  );
}

/** TransferDialog takes a Member; a guest owner is one (R.memberTransfer accepts guests). */
const asMember = (g: GuestOwner): Member => ({
  id: g.userId,
  email: g.email,
  name: null,
  role: "guest",
  lastSeenAt: null,
  status: "active",
});
