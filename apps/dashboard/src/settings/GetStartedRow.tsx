import { Button } from "@oa/ui/shadcn";
import { withLocal } from "../api/myOnboarding";
import { useOnboarding, useSetOnboarding } from "../api/queries";
import { useMe } from "../auth/useMe";
import { toast } from "../layout/toast";
import { isMember, rememberNoCard } from "../library/MemberGetStarted";
import { muted } from "./ui";

// Copy checked by OA Product (#3029); the label matches the card title.
export const GET_STARTED_ROW_LABEL = "Get started";
export const GET_STARTED_ROW_TEXT = "Hidden from your Library.";
export const GET_STARTED_ROW_BUTTON = "Show it again";
export const GET_STARTED_BACK_TOAST = "Get started is back in your Library.";

/**
 * Settings › Profile: a hidden Get started checklist (member or owner card)
 * comes back with one click. Rendered only while it is hidden and not done.
 */
export function GetStartedRow() {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const role = me?.user.role;
  const userId = me?.user.id;
  const onboarding = useOnboarding(role === "owner" || isMember(role));
  const member = isMember(role) && userId ? { userId } : undefined;
  const save = useSetOnboarding(member);
  const o = member ? withLocal(onboarding.data, userId) : onboarding.data;
  if (o?.dismissed !== true || o.completed === true) return null;
  return (
    <div className="mt-[var(--oa-space-4)] flex items-start justify-between gap-[var(--oa-space-3)]">
      <div>
        <b className="block text-[length:var(--oa-text-sm)] font-medium">
          {GET_STARTED_ROW_LABEL}
        </b>
        <small className={muted}>{GET_STARTED_ROW_TEXT}</small>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={save.isPending}
        onClick={() =>
          save.mutate(
            { dismissed: false },
            {
              onSuccess: () => {
                if (userId) rememberNoCard(userId, false);
                toast({ title: GET_STARTED_BACK_TOAST, tone: "success" });
              },
            },
          )
        }
      >
        {GET_STARTED_ROW_BUTTON}
      </Button>
    </div>
  );
}
