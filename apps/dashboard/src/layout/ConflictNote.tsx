// Design's 409 note: small warning text, a polite status (not an alert).
import { CONFLICT_COPY } from "../api/errorCopy";

export function ConflictNote({ className = "" }: { className?: string }) {
  return (
    <p
      role="status"
      className={`m-0 text-[length:var(--oa-text-sm)] text-[var(--oa-warning)] ${className}`}
    >
      {CONFLICT_COPY}
    </p>
  );
}
