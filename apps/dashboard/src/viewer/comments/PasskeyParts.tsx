import { Clock, KeyRound } from "lucide-react";
import { AppLink } from "../../library/AppLink";
import { TXT } from "../ui";
import { coolingTime, type PasskeyFailure } from "./passkey";

const MUTED = "text-muted-foreground";

// TODO(#2263): the base64url and assertion helpers in passkey.ts move to apps/dashboard/src/auth/webauthn.ts later; keep them here for now.

/** The neutral inset for an account that can't approve yet: no passkey, or a new one still cooling (#2263). */
export function PasskeyBlocked({ f }: { f: PasskeyFailure }) {
  if (f.kind !== "no_passkey" && f.kind !== "cooling") return null;
  const when = f.kind === "cooling" ? coolingTime(f.usableAt) : null;
  return (
    <div
      data-passkey-error={f.kind}
      className={`flex w-full flex-col gap-1 rounded-md bg-[var(--oa-surface-2,hsl(var(--muted)))] p-2 ${TXT}`}
    >
      <p className="m-0 flex items-start gap-2 break-words">
        {f.kind === "cooling" ? (
          <Clock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        ) : (
          <KeyRound aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        )}
        {f.kind === "cooling" ? (
          <span>
            Your new passkey can approve from{" "}
            <span title={when?.title}>{when?.text ?? "later"}</span>
          </span>
        ) : (
          <span>
            <AppLink href="/settings/security" className="underline">
              Add a passkey to approve this here
            </AppLink>
          </span>
        )}
      </p>
      {f.kind === "no_passkey" && (
        <p className={`m-0 ${MUTED}`}>Or answer in your agent's terminal.</p>
      )}
    </div>
  );
}
