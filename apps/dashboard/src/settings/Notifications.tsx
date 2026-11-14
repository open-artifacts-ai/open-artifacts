import {
  COMMENT_EMAIL_HELP,
  COMMENT_EMAIL_HELP_NO_SENDER,
  COMMENT_EMAIL_LABEL,
  type Me,
} from "@oa/shared";
import { useUpdateMe } from "../api/queries";
import { useMe } from "../auth/useMe";
import { toast } from "../layout/toast";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { ForYouPrefs } from "./ForYouPrefs";
import { Switch } from "./spaces/Switch";
import { muted, SettingsCard } from "./ui";

/** Settings › Notifications: the comment email switch (#1467). */
export function Notifications() {
  useDocumentTitle("Notifications");
  const state = useMe();
  if (state.status !== "authed") return null;
  // #2512: For you's settings when the server has it (Me.inbox); today's email switch stays as it is.
  return (
    <div className="grid max-w-[620px] min-w-0 gap-[var(--oa-space-4)]">
      {state.me.inbox && <ForYouPrefs />}
      <CommentEmail me={state.me} />
    </div>
  );
}

function CommentEmail({ me }: { me: Me }) {
  const update = useUpdateMe();
  // No sender on this instance: nothing is sent, so the switch is off and says why.
  const sender = me.instance.emailEnabled;
  // On unless turned off; older servers omit the field (on).
  const saved = me.commentEmail !== false;
  // While saving, show the choice made; the response replaces Me.
  const on =
    sender && (update.isPending ? update.variables?.commentEmail : saved);
  return (
    <section className="max-w-[560px]" aria-label="Notifications">
      <SettingsCard id="oa-notifications-email" title="Email">
        <div className="flex items-start justify-between gap-[var(--oa-space-3)]">
          <div>
            <b className="block text-[length:var(--oa-text-sm)] font-medium">
              {COMMENT_EMAIL_LABEL}
            </b>
            <small id="oa-comment-email-hint" className={muted}>
              {sender ? COMMENT_EMAIL_HELP : COMMENT_EMAIL_HELP_NO_SENDER}
            </small>
          </div>
          <Switch
            label={COMMENT_EMAIL_LABEL}
            describedBy="oa-comment-email-hint"
            checked={on === true}
            disabled={!sender || update.isPending}
            onChange={(next) =>
              update.mutate(
                { commentEmail: next },
                {
                  onError: () =>
                    toast({ title: "Couldn't save that.", tone: "danger" }),
                },
              )
            }
          />
        </div>
      </SettingsCard>
    </section>
  );
}
