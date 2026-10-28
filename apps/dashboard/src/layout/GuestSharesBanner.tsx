// Parity 2 (decision A6): guests are view-only on every install. The owner of
// a self-hosted install that had guest editors sees, once, which shares
// changed; Dismiss ends it for good (R.noticeDismiss).
import type { Me } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useDismissNotice } from "../api/queries";
import { AppLink } from "../library/AppLink";
import { Notice } from "./Notice";

export function GuestSharesBanner({
  me,
  className = "",
}: {
  me: Me | null | undefined;
  /** The page's content column, so the banner's edges line up with it. */
  className?: string;
}) {
  const dismiss = useDismissNotice();
  const notice = me?.notices?.guestShares;
  if (!notice || notice.items.length === 0) return null;
  return (
    <div className={`mb-[var(--oa-space-3)] ${className}`}>
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
          These guests had edit access, which now works as view-only. To let
          someone edit, make them a member.
        </p>
        <ul
          aria-label="Shares that became view-only"
          className="m-0 grid max-h-[220px] gap-[2px] overflow-auto pl-[18px]"
        >
          {notice.items.map((i) => (
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
        {notice.more && (
          <p>
            Plus others not listed here. Check Share on your artifacts for other
            guest editors.
          </p>
        )}
      </Notice>
    </div>
  );
}
