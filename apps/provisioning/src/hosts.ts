import type { Env } from "./env.js";

/** The two hosts of this Worker (2.2): cookies on admin, bearers on api. */
export type HostKind = "admin" | "api";

export function hostKind(hostname: string, env: Env): HostKind | null {
  const h = hostname.toLowerCase();
  if (h === `admin.${env.APP_DOMAIN}`) return "admin";
  if (h === `api.${env.APP_DOMAIN}`) return "api";
  return null;
}
