// GET /upgrade.md on the app host: this instance's upgrade Agent Skill, from
// the pre-rendered template (upgrade.generated.ts) with its tokens filled in.
// Same shape as /skill.md: one regex pass, memoized per isolate, no D1 or
// session. SKILL_MD=off turns it off too, and HOSTED=1 always does: a hosted
// tenant is upgraded by the platform, never by the self-host oa:setup flow
// (review item 39).
import type { Context } from "hono";
import type { Env } from "../env.js";
import type { AppEnv } from "../http/middleware.js";
import { VERSION } from "../version.gen.js";
import { skillEnabled } from "./skill.js";
import {
  DEFAULT_INSTALL_NAME,
  hostSlug,
  skillName,
  skillOrigin,
} from "./skill-common.js";
import { UPGRADE_HASH, UPGRADE_TEMPLATE } from "./upgrade.generated.js";

export const UPGRADE_PATH = "/upgrade.md";

type UpgradeEnv = Pick<
  Env,
  "APP_HOST" | "ENVIRONMENT" | "SKILL_MD" | "WORKER_NAME"
>;

const memo = new Map<string, Promise<string>>();

/** The upgrade skill for this instance. */
export function renderUpgrade(env: UpgradeEnv): Promise<string> {
  const workerName = env.WORKER_NAME?.trim() || DEFAULT_INSTALL_NAME;
  const key = `${env.ENVIRONMENT}|${env.APP_HOST}|${workerName}`;
  let p = memo.get(key);
  if (!p) {
    p = skillName(env.APP_HOST, "-upgrade").then((name) => {
      const v: Record<string, string> = {
        origin: skillOrigin(env.APP_HOST),
        host: env.APP_HOST,
        name,
        version: VERSION,
        workerName,
        hostSlug: hostSlug(env.APP_HOST),
      };
      return UPGRADE_TEMPLATE.replace(
        /\{\{(\w+)\}\}/g,
        (m, k: string) => v[k] ?? m,
      );
    });
    memo.set(key, p);
  }
  return p;
}

/** ETag: the version and template hash (host and Worker name are fixed per deploy). */
export const UPGRADE_ETAG = `"${VERSION}-upgrade-${UPGRADE_HASH}"`;

export async function serveUpgrade(c: Context<AppEnv>) {
  if (!skillEnabled(c.env) || c.env.HOSTED === "1") return c.notFound();
  const headers = {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    ETag: UPGRADE_ETAG,
  };
  const inm = c.req.header("if-none-match");
  if (
    inm
      ?.split(/\s*,\s*/)
      .some((t) => t === UPGRADE_ETAG || t === `W/${UPGRADE_ETAG}` || t === "*")
  )
    return c.body(null, 304, headers);
  return c.body(await renderUpgrade(c.env), 200, headers);
}
