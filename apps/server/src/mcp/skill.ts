// GET /skill.md on the app host: this instance's Agent Skill, from the
// pre-rendered template (skill.generated.ts) with its tokens filled in. One
// regex pass, memoized per isolate (APP_HOST, PLAN and VERSION are constant
// per deploy): no D1, no session, no Zod or Markdown work per request.
import { dataDocLimit, dataLimits, parseFeatures } from "@oa/shared";
import type { Context } from "hono";
import type { Env } from "../env.js";
import type { AppEnv } from "../http/middleware.js";
import { VERSION } from "../version.gen.js";
import { planText } from "./instructions.js";
import {
  SKILL_HASH,
  SKILL_HASH_NO_SPACES,
  SKILL_TEMPLATE,
  SKILL_TEMPLATE_NO_SPACES,
} from "./skill.generated.js";
import { hostSlug, skillName, skillOrigin } from "./skill-common.js";

export const SKILL_PATH = "/skill.md";
export const SKILL_DOC_URI = "openartifacts://docs/skill";

type SkillEnv = Pick<
  Env,
  | "APP_HOST"
  | "ENVIRONMENT"
  | "PLAN"
  | "SKILL_MD"
  | "DATA_DOC_BYTES"
  | "HOSTED"
  | "FEATURES"
>;

/**
 * The install has the spaces feature: the skill keeps its spaces lines
 * (list_spaces, the shared-space wording). Without it they are left out, as
 * tools/list and the server instructions leave them out (parity 1).
 */
const spacesIn = (env: Pick<Env, "FEATURES">): boolean =>
  parseFeatures(env.FEATURES).includes("spaces");

/**
 * The skill's upgrade line (with its paragraph break), or "" on HOSTED=1:
 * a hosted tenant can't run the self-host upgrade, and /upgrade.md is 404
 * there (review item 39).
 */
export const upgradeLine = (env: Pick<Env, "APP_HOST" | "HOSTED">): string =>
  env.HOSTED === "1"
    ? ""
    : `To upgrade this instance to the latest release: ${skillOrigin(env.APP_HOST)}/upgrade.md.\n\n`;

/** Public by default; SKILL_MD=off (any case) turns the route and resource off. */
export const skillEnabled = (env: Pick<Env, "SKILL_MD">): boolean =>
  env.SKILL_MD?.trim().toLowerCase() !== "off";

export const skillUrl = (env: SkillEnv): string | undefined =>
  skillEnabled(env) ? skillOrigin(env.APP_HOST) + SKILL_PATH : undefined;

const memo = new Map<string, Promise<string>>();

/** The skill for this instance. */
export function renderSkill(env: SkillEnv): Promise<string> {
  const { plan, docBytes } = dataLimits(env);
  const hosted = env.HOSTED === "1" ? "h" : "";
  const spaces = spacesIn(env);
  const key = `${env.ENVIRONMENT}|${env.APP_HOST}|${plan}|${docBytes}|${hosted}|${spaces ? "s" : ""}`;
  let p = memo.get(key);
  if (!p) {
    p = skillName(env.APP_HOST).then((name) => {
      const v: Record<string, string> = {
        ...planText(plan, docBytes),
        origin: skillOrigin(env.APP_HOST),
        host: env.APP_HOST,
        name,
        hostSlug: hostSlug(env.APP_HOST),
        version: VERSION,
        upgradeLine: upgradeLine(env),
      };
      const tpl = spaces ? SKILL_TEMPLATE : SKILL_TEMPLATE_NO_SPACES;
      return tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => v[k] ?? m);
    });
    // A failure is not memoized: the next request tries again.
    p = p.catch((e: unknown) => {
      memo.delete(key);
      throw e;
    });
    memo.set(key, p);
  }
  return p;
}

/**
 * ETag: version, plan and the template's hash (a git-less build keeps one
 * VERSION across template changes), plus the data-doc limit when
 * DATA_DOC_BYTES overrides the plan's, and "nospaces-" (with that
 * template's hash) without the spaces feature. The host is fixed per deploy.
 */
export const skillEtag = (
  env: Pick<Env, "PLAN" | "DATA_DOC_BYTES" | "HOSTED" | "FEATURES">,
): string => {
  const { plan, docBytes } = dataLimits(env);
  const doc = docBytes === dataDocLimit(plan) ? "" : `-${docBytes}`;
  const hosted = env.HOSTED === "1" ? "-hosted" : "";
  const tpl = spacesIn(env) ? SKILL_HASH : `nospaces-${SKILL_HASH_NO_SPACES}`;
  return `"${VERSION}-${plan}${doc}${hosted}-${tpl}"`;
};

export async function serveSkill(c: Context<AppEnv>) {
  if (!skillEnabled(c.env)) return c.notFound();
  const etag = skillEtag(c.env);
  const headers = {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    ETag: etag,
  };
  const inm = c.req.header("if-none-match");
  if (
    inm
      ?.split(/\s*,\s*/)
      .some((t) => t === etag || t === `W/${etag}` || t === "*")
  )
    return c.body(null, 304, headers);
  return c.body(await renderSkill(c.env), 200, headers);
}
