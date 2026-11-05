// A compare-and-set refusal (409 conflict): the thing changed since it was
// read. A status in warning colour, not an alert: it isn't the user's mistake.
import { ApiClientError } from "../api/client";

export const CONFLICT = "This artifact just changed. Check it and try again.";

export const isConflict = (e: unknown) =>
  e instanceof ApiClientError && e.code === "conflict";

export function ConflictNote() {
  return (
    <p
      role="status"
      className="m-0 text-[length:var(--oa-text-sm)] text-[var(--oa-warning)]"
    >
      {CONFLICT}
    </p>
  );
}
