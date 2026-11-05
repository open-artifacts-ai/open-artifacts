// GET /skill.md on the app host: this instance's Agent Skill, from the
// pre-rendered template (skill.generated.ts) with its tokens filled in. One
// regex pass, memoized per isolate (APP_HOST, PLAN and VERSION are constant
// per deploy): no D1, no session, no Zod or Markdown work per request.
import {
  dataDocLimit,
  dataLimits,
  type Harness,
  harnessSkills,
  parseFeatures,
  parseHarness,
} from "@oa/shared";
import type { Context } from "hono";
import type { Env } from "../env.js";
import type { AppEnv } from "../http/middleware.js";
import { busOn } from "../services/bus.js";
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
  | "BUS_HUB"
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

/**
 * The skill's lines on the bus, or "" without the bus. The caller passes
 * busOn (BUS_HUB bound and not hosted, the routes' own switch), so the skill
 * can never teach the bus with the hub off, or hide it with the hub on. The
 * tools it names come from the harness, not from /mcp.
 */
export const busLine = (on: boolean): string =>
  on
    ? "- Find peers by bus name with list_agents (it comes from the bus client, not from /mcp), and reply by that name: your harness's own session list does not show agents on other machines.\n" +
      "- To message agents, use the bus tools installed for your harness: the oa_bus MCP server, or the oa-bus extension. Don't borrow another harness's config to get them. If they fail, report it to your human with the error and any fix it suggests; don't run that fix without their yes.\n"
    : "";

export const skillUrl = (env: SkillEnv): string | undefined =>
  skillEnabled(env) ? skillOrigin(env.APP_HOST) + SKILL_PATH : undefined;

/**
 * The per-harness line for `/skill.md?harness=`, or "" without a known
 * harness: an install renders the tool names that install gives the agent, and
 * every other fetch gets exactly the bytes it got before the parameter
 * existed. No harness names here: the served text stays vendor-neutral, so it
 * names tool names and the skill path, not products (`#1456` step 3).
 */
export const harnessNote = (harness: Harness | undefined): string => {
  if (!harness) return "";
  const { skillPath, busToolName } = harnessSkills[harness];
  const tools = busToolName
    ? `its bus tools are named \`${busToolName("list_agents")}\` and \`${busToolName("send_message")}\` (list_agents, send_message)`
    : "its bus tools keep the names the harness gives them";
  return `This copy was rendered for one harness: ${tools}, and the skill file lives at \`${skillPath}\`.\n\n`;
};

const memo = new Map<string, Promise<string>>();

/** The skill for this instance, optionally rendered for one harness. */
export function renderSkill(
  env: SkillEnv,
  harness?: Harness | undefined,
): Promise<string> {
  const { plan, docBytes } = dataLimits(env);
  const hosted = env.HOSTED === "1" ? "h" : "";
  const spaces = spacesIn(env);
  const bus = busOn(env);
  const key = `${env.ENVIRONMENT}|${env.APP_HOST}|${plan}|${docBytes}|${hosted}|${spaces ? "s" : ""}|${bus ? "b" : ""}|${harness ?? ""}`;
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
        busPeers: busLine(bus),
      };
      const tpl = spaces ? SKILL_TEMPLATE : SKILL_TEMPLATE_NO_SPACES;
      const md = tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => v[k] ?? m);
      // The harness note is inserted at render time, before "## Connect", so
      // the template (and every absent-harness byte) stays exactly as it was.
      const note = harnessNote(harness);
      return note ? md.replace("\n## Connect", `\n${note}## Connect`) : md;
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
  harness?: Harness | undefined,
): string => {
  const { plan, docBytes } = dataLimits(env);
  const doc = docBytes === dataDocLimit(plan) ? "" : `-${docBytes}`;
  const hosted = env.HOSTED === "1" ? "-hosted" : "";
  const tpl = spacesIn(env) ? SKILL_HASH : `nospaces-${SKILL_HASH_NO_SPACES}`;
  return `"${VERSION}-${plan}${doc}${hosted}-${tpl}${harness ? `-${harness}` : ""}"`;
};

export async function serveSkill(c: Context<AppEnv>) {
  if (!skillEnabled(c.env)) return c.notFound();
  const harness = parseHarness(c.req.query("harness"));
  const etag = skillEtag(c.env, harness);
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
  return c.body(await renderSkill(c.env, harness), 200, headers);
}
