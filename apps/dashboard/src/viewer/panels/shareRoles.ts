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
 * Is a typed `email` outside the instance? Where the org lists its login
 * domains (Google): when it's at none of them. Where it lists none (OA
 * Product, #2590): when it isn't a known member, so the outsider's choices
 * show before it's saved. `members` is the known members' addresses
 * (lowercase), or null when the caller can't list them (only owners and
 * admins can): then every address counts as outside. Null for an address
 * still being typed.
 */
export function outsideAddress(
  email: string,
  domains: readonly string[],
  members: ReadonlySet<string> | null,
): boolean | null {
  const e = email.trim().toLowerCase();
  const at = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(e)?.[1];
  if (!at) return null;
  if (domains.length) return !domains.some((d) => d.toLowerCase() === at);
  return !members?.has(e);
}

/**
 * OA Product (#2590, the issue's Strings): the line under an outside
 * address, by how they can log in here. Null when nothing admits them (the
 * warning after saving says why).
 */
export function outsideLine(
  name: string,
  methods: { google: boolean; codes: boolean },
): string | null {
  if (methods.google && methods.codes)
    return `Outside your team. ${name} opens this page with their Google account or a code we email them. They see only what you share. Free.`;
  if (methods.google)
    return `Outside your team. ${name} opens this page with their Google account. They see only what you share. Free.`;
  if (methods.codes)
    return `Outside your team. ${name} opens this page with a code we email them. They see only what you share. Free.`;
  return null;
}
