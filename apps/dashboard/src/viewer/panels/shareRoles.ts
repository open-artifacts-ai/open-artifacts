// #2590: per-share roles, with "commenter" for people outside the instance.
//
// PROVISIONAL (#2590, until OA Comments' contract PR lands in
// packages/shared): ShareRoleSchema there becomes viewer | commenter | editor
// with no new field, and shares to an outside address default to commenter.
// Until then the dashboard widens the role here; swap these for the shared
// schemas when it lands.
import { ShareResultSchema, ShareSchema } from "@oa/shared";
import { z } from "zod";

export const WideShareRoleSchema = z.enum(["viewer", "commenter", "editor"]);
export type WideShareRole = z.infer<typeof WideShareRoleSchema>;
export const WideShareSchema = ShareSchema.extend({
  role: WideShareRoleSchema,
});
export type WideShare = z.infer<typeof WideShareSchema>;
export const WideShareResultSchema = ShareResultSchema.extend({
  role: WideShareRoleSchema,
});
export type WideShareInput = { email: string; role: WideShareRole };

type Option = { value: WideShareRole; label: string };
/** A member's choices, as before. */
export const MEMBER_ROLES: Option[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
];
/** OA Product (#2590): an outsider's choices, in this order. */
export const OUTSIDER_ROLES: Option[] = [
  { value: "commenter", label: "Can comment" },
  { value: "viewer", label: "Can view" },
];
/** #2590: an outsider's share starts as Can comment. */
export const OUTSIDER_DEFAULT: WideShareRole = "commenter";

/** What a share's role reads as: a commenter is "Can comment" everywhere. */
export function roleLabel(role: WideShareRole, outsider: boolean): string {
  if (role === "commenter") return "Can comment";
  const list = outsider ? OUTSIDER_ROLES : MEMBER_ROLES;
  return (
    list.find((o) => o.value === role)?.label ??
    MEMBER_ROLES.find((o) => o.value === role)?.label ??
    role
  );
}

/**
 * The choices for one share: an outsider's, or a member's. A stored role
 * outside them (an outsider's old Editor share, a member's commenter one)
 * stays listed so the picker never shows a blank.
 */
export function roleOptions(
  outsider: boolean,
  current?: WideShareRole,
): Option[] {
  const list = outsider ? OUTSIDER_ROLES : MEMBER_ROLES;
  if (!current || list.some((o) => o.value === current)) return list;
  return [...list, { value: current, label: roleLabel(current, false) }];
}

/**
 * Is `email` outside the instance, as far as the sign-in domains tell? True
 * when the org lists its domains (Google) and the address is at none of
 * them; null when it can't tell (no domains listed): the server's `guest` on
 * the saved row decides then.
 */
export function outsideDomains(
  email: string,
  domains: readonly string[],
): boolean | null {
  if (!domains.length) return null;
  const at = email.trim().toLowerCase().split("@")[1];
  if (!at) return null;
  return !domains.some((d) => d.toLowerCase() === at);
}
