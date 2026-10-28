import { SPACE_NAME_RESERVED_MESSAGE, SpaceNameSchema } from "@oa/shared";
import { ApiClientError } from "../../api/client";

export const NAME_EMPTY = "Enter a space name.";
export const NAME_LONG = "Use 80 characters or fewer.";
export const NAME_RESERVED =
  "Everyone already has a space called Personal. Use another name.";

/**
 * A typed space name through the server's own schema: the cleaned name to
 * save, or the inline error. Never says what was stripped.
 */
export const checkName = (
  raw: string,
): { name: string; error: null } | { name: null; error: string } => {
  const r = SpaceNameSchema.safeParse(raw);
  if (r.success) return { name: r.data, error: null };
  return {
    name: null,
    error: r.error.issues.some((i) => i.message === SPACE_NAME_RESERVED_MESSAGE)
      ? NAME_RESERVED
      : r.error.issues.some((i) => i.code === "too_big")
        ? NAME_LONG
        : NAME_EMPTY,
  };
};

/** A server 400 on a name says the same thing the field would. */
export const nameRefusal = (e: unknown, raw: string): string | null =>
  e instanceof ApiClientError && e.status === 400
    ? e.code === "space_name_reserved"
      ? NAME_RESERVED
      : (checkName(raw).error ?? NAME_EMPTY)
    : null;
