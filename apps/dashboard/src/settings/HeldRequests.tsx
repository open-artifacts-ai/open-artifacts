/**
 * #2577 (Design v8, Settings): "Held requests". Whether a held request of
 * someone else asking the caller's agent is also sent to their phone as a
 * notification. Off: they wait in the inbox.
 */
import { useAgentRequests, useSetPhonePush } from "../api/agentAsks";
import { errorCopy } from "../api/errorCopy";
import { PUSH_WORDS, permission, usePushKey } from "../foryou/push";
import { toast } from "../layout/toast";
import { useInstanceName } from "../layout/useDocumentTitle";
import { AppLink } from "../library/AppLink";
import { Switch } from "./spaces/Switch";
import { errorText, muted, SettingsCard, WriteLock } from "./ui";

export const PHONE_OFF = "Off: they wait in your inbox.";
export const PHONE_ON =
  "On: a held request also sends a notification to your phone. It waits in your inbox too.";
const NOTIFICATIONS = "/settings/notifications";

export function HeldRequests() {
  const sw = useAgentRequests();
  const save = useSetPhonePush();
  const key = usePushKey(true);
  const site = useInstanceName();
  const on = save.isPending ? save.variables : (sw.data?.phonePush ?? false);
  const perm = permission();
  // Browser notifications can't reach anyone here: say so, and where to fix it.
  const blocked =
    key.isSuccess && !key.data
      ? PUSH_WORDS.notSetUp(site)
      : perm === "denied"
        ? PUSH_WORDS.blocked
        : perm === "unsupported"
          ? PUSH_WORDS.cant
          : null;
  return (
    <SettingsCard id="oa-held-h" title="Held requests">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[length:var(--oa-text-sm)]">
          Send held requests to my phone
        </span>
        <WriteLock>
          <Switch
            label="Send held requests to my phone"
            describedBy="oa-held-hint"
            checked={on}
            disabled={sw.isPending || sw.isError}
            onChange={(next) =>
              save.mutate(next, {
                onError: (e) =>
                  toast({
                    title: errorCopy(e, "Couldn't save that. Try again."),
                    tone: "danger",
                  }),
              })
            }
          />
        </WriteLock>
      </div>
      <p id="oa-held-hint" className={`m-0 ${muted}`}>
        {on ? PHONE_ON : PHONE_OFF}
      </p>
      {blocked && (
        <p data-held-blocked="" className={`m-0 ${muted}`}>
          {blocked}{" "}
          <AppLink href={NOTIFICATIONS} className="underline">
            Settings, Notifications
          </AppLink>
        </p>
      )}
      {sw.isError && (
        <p role="alert" className={errorText}>
          Couldn't load this setting.
        </p>
      )}
    </SettingsCard>
  );
}
