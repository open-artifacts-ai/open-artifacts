import { Button } from "@oa/ui/shadcn";
import { Clock, KeyRound } from "lucide-react";
import { HIGH_STAKES } from "../../api/highStakes";
import { AppLink } from "../../library/AppLink";
import { TXT } from "../ui";
import { coolingTime, type PasskeyFailure } from "./passkey";

/** #2661: no passkey yet: one button to Settings, Security, never a dead prompt. */
export function PasskeyMissing() {
  return (
    <div
      data-passkey-error="no_passkey"
      data-passkey-missing=""
      className={`flex w-full rounded-md bg-[var(--oa-surface-2,hsl(var(--muted)))] p-2 ${TXT}`}
    >
      <Button asChild size="sm" variant="outline">
        <AppLink href="/settings/security">
          <KeyRound aria-hidden="true" className="size-3.5" />
          {HIGH_STAKES.missing}
        </AppLink>
      </Button>
    </div>
  );
}

/** The neutral inset for an account that can't approve yet: no passkey, or a new one still cooling (#2263). */
export function PasskeyBlocked({ f }: { f: PasskeyFailure }) {
  if (f.kind === "no_passkey") return <PasskeyMissing />;
  if (f.kind !== "cooling") return null;
  const when = coolingTime(f.usableAt);
  return (
    <div
      data-passkey-error={f.kind}
      className={`flex w-full flex-col gap-1 rounded-md bg-[var(--oa-surface-2,hsl(var(--muted)))] p-2 ${TXT}`}
    >
      <p className="m-0 flex items-start gap-2 break-words">
        <Clock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Your new passkey can approve from{" "}
          <span title={when?.title}>{when?.text ?? "later"}</span>
        </span>
      </p>
    </div>
  );
}
