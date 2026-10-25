import { type Me, MeSchema, R } from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, api } from "../api/client";
import { BreakGlassRequiredDetailsSchema } from "../api/contract";
import { qk } from "../api/queries";
import { isEmbed } from "../embed";

export type MeState =
  | { status: "loading" }
  | { status: "anonymous" }
  /** The org owner locked out by a directory customer_mismatch (401 break_glass_required). */
  | { status: "breakGlass"; fresh: boolean }
  | { status: "error"; error: unknown }
  | { status: "authed"; me: Me };

/** A 401 means anonymous, even over stale data (expired session), except
    break_glass_required, the owner's way back in; other failures are `error`.
    Framed (embed mode), always anonymous and never fetched. */
export function useMe(): MeState {
  const embed = isEmbed();
  const q = useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.get(R.me, MeSchema, signal),
    staleTime: 60_000,
    enabled: !embed,
  });
  if (embed) return { status: "anonymous" };
  if (q.error instanceof ApiClientError && q.error.status === 401) {
    const bg = BreakGlassRequiredDetailsSchema.safeParse(q.error.details);
    return q.error.code === "break_glass_required" && bg.success
      ? { status: "breakGlass", fresh: bg.data.fresh }
      : { status: "anonymous" };
  }
  if (q.data) return { status: "authed", me: q.data };
  if (q.error) return { status: "error", error: q.error };
  return { status: "loading" };
}
