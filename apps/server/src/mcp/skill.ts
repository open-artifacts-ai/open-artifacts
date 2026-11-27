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
import { docsAvailable } from "../services/docs-available.js";
import { VERSION } from "../version.gen.js";
import { planText } from "./instructions.js";
import {
  SKILL_HASH,
  SKILL_HASH_NO_SPACES,
  SKILL_PART_HASHES,
  SKILL_PART_HASHES_NO_SPACES,
  SKILL_PART_TEMPLATES,
  SKILL_PART_TEMPLATES_NO_SPACES,
  SKILL_TEMPLATE,
  SKILL_TEMPLATE_NO_SPACES,
} from "./skill.generated.js";
import { hostSlug, skillName, skillOrigin } from "./skill-common.js";
import {
  DOC_TOOL_CLOSE,
  DOC_TOOL_OPEN,
  SKILL_PARTS,
  type SkillPart,
  TOOL_COUNT_RE,
} from "./skill-template.js";

export const SKILL_PATH = "/skill.md";
export const SKILL_PART_PATH = "/skill/:part";
export const SKILL_DOC_URI = "openartifacts://docs/skill";
export const IMPORT_DOC_URI = "openartifacts://docs/import";

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
  | "DOCS_PREVIEW"
>;

/**
 * The doc-gated tool section (edit_doc) and the tool count, per install: kept
 * only when docsAvailable(env), as tools/list offers the tool (#2578).
 */
export const applyDocTools = (md: string, docs: boolean): string => {
  const withMarks = md.replace(TOOL_COUNT_RE, (_, all: string, none: string) =>
    docs ? all : none,
  );
  if (docs)
    return withMarks
      .replaceAll(DOC_TOOL_OPEN, "")
      .replaceAll(DOC_TOOL_CLOSE, "");
  const a = withMarks.indexOf(`\n\n${DOC_TOOL_OPEN}`);
  const b = withMarks.indexOf(DOC_TOOL_CLOSE);
  return a < 0 || b < a
    ? withMarks
    : withMarks.slice(0, a) + withMarks.slice(b + DOC_TOOL_CLOSE.length);
};

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
 * The skill's words on the bus being part of setup. OA Product edits this;
 * plain words, no em dashes.
 */
export const busSetupLine = (origin: string): string =>
  `- The bus is part of Open Artifacts setup, not an extra. If you find no bus tools (oa_bus), setup is not finished: tell your person, and when they say go, follow the "Install the bus" step of ${origin}/llms.txt (it checks the download before running it; never run \`npx @open-artifacts/bus\`). They approve this machine once in their browser. See https://open-artifacts.com/docs/agent-bus/.`;

/** #2476, #2477: the naming and first-page habits, taught only with the bus on. */
const FIRST_PAGE_HABIT =
  '- Setup is unfinished only when the `list_artifacts` tool with `scope: "mine"` shows no pages of your person on this instance (colleagues\' pages don\'t count). Only then, even in a new session, finish it now: ask your person what to call you (suggest a short name from the project) and check the bus `self` tool shows it. If they already have pages, never re-run setup or ask for a name again. Then publish the first page: a short page about the project you\'re in, with `visibility: "private"`. Right after publishing it, post a comment ("I\'m {name}, your agent. Type @{name} in any comment and I\'ll answer in the thread. Try it here.") and an ask to `me` ("What should I publish next?", options fitted to the project, such as "A status page for this project", "A summary of the README", "Nothing for now"). When they pick, do it and reply in the thread; "Nothing for now" gets a one-line reply. Do this once, never on later pages. Then tell your person Open Artifacts is connected, with the address and the page\'s link. Use your session name if they skipped naming, and follow that page so the mention and the pick reach you.';

export const busLine = (on: boolean, origin: string): string =>
  on
    ? "- Find peers by bus name with the oa_bus list_agents tool (it comes from the bus client, not from /mcp), and reply by that name: your harness's own session list does not show agents on other machines.\n" +
      "- To message agents, use the bus tools installed for your harness: the oa_bus MCP server, or the oa-bus extension. Don't borrow another harness's config to get them. If they fail, report it to your human with the error and any fix it suggests; don't run that fix without their yes.\n" +
      busSetupLine(origin) +
      "\n" +
      FIRST_PAGE_HABIT +
      "\n"
    : "";

export const skillUrl = (env: SkillEnv): string | undefined =>
  skillEnabled(env) ? skillOrigin(env.APP_HOST) + SKILL_PATH : undefined;

/**
 * The per-harness line for `/skill.md?harness=`, or "" without a known
 * harness or with the bus off: the skill never teaches the bus when the hub is
 * off. Vendor-neutral on purpose (a neutral test fetches every variant): it
 * names tool names, never a harness path or a vendor. The shared-folder copy
 * names harnesses so an agent can pick its own tools (#1963).
 */
export const harnessNote = (
  harness: Harness | undefined,
  on: boolean,
): string => {
  if (!harness || !on) return "";
  const { busToolName, skillPath } = harnessSkills[harness];
  // #1963: ~/.agents/skills (pi and omp's copy) is read by Codex 0.94+,
  // OpenCode, OpenClaw and, when opted in, Hermes, so that copy names each
  // harness's bus tools.
  if (skillPath.startsWith("~/.agents/skills/"))
    return "Several harnesses read this copy, and each names the bus tools differently: `oabus_list_agents` and `oabus_send_message` in pi, oh-my-pi, OpenClaw and Hermes; `mcp__oa_bus__list_agents` and `mcp__oa_bus__send_message` in Codex; `oa_bus_list_agents` and `oa_bus_send_message` in OpenCode. Use the names your harness shows.\n\n";
  return `This copy is for one harness: here \`${busToolName("list_agents")}\` is list_agents and \`${busToolName("send_message")}\` is send_message.\n\n`;
};

const memo = new Map<string, Promise<string>>();

/** FNV-1a, 32 bits: a short, stable suffix for an ETag. */
const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/** The skill for this instance, optionally rendered for one harness. */
export function renderSkill(
  env: SkillEnv,
  harness?: Harness | undefined,
): Promise<string> {
  const { plan, docBytes } = dataLimits(env);
  const hosted = env.HOSTED === "1" ? "h" : "";
  const spaces = spacesIn(env);
  const bus = busOn(env);
  const docs = docsAvailable(env);
  const key = `${env.ENVIRONMENT}|${env.APP_HOST}|${plan}|${docBytes}|${hosted}|${spaces ? "s" : ""}|${bus ? "b" : ""}|${docs ? "d" : ""}|${harness ?? ""}`;
  let p = memo.get(key);
  if (!p) {
    p = fillSkillTokens(
      spaces ? SKILL_TEMPLATE : SKILL_TEMPLATE_NO_SPACES,
      env,
      plan,
      docBytes,
      bus,
      docs,
    ).then((md) => {
      // The harness note is inserted at render time, before "## Connect", so
      // the template (and every absent-harness byte) stays exactly as it was.
      const note = harnessNote(harness, bus);
      if (!note) return md;
      const origin = skillOrigin(env.APP_HOST);
      return (
        md
          .replace("\n## Connect", `\n${note}## Connect`)
          // A refresh must keep the note: the same harness on the refetch URL.
          .replaceAll(
            `${origin}/skill.md`,
            `${origin}/skill.md?harness=${harness}`,
          )
      );
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

const fillSkillTokens = (
  tpl: string,
  env: SkillEnv,
  plan: ReturnType<typeof dataLimits>["plan"],
  docBytes: number,
  bus: boolean,
  docs: boolean,
): Promise<string> =>
  skillName(env.APP_HOST).then((name) => {
    const origin = skillOrigin(env.APP_HOST);
    const v: Record<string, string> = {
      ...planText(plan, docBytes),
      origin,
      host: env.APP_HOST,
      name,
      hostSlug: hostSlug(env.APP_HOST),
      version: VERSION,
      upgradeLine: upgradeLine(env),
      busPeers: busLine(bus, origin),
    };
    // Before the values go in: an install value containing the marker text
    // must not be cut.
    return applyDocTools(tpl, docs).replace(
      /\{\{(\w+)\}\}/g,
      (m, k: string) => v[k] ?? m,
    );
  });

/** Parses `<part>.md` from `/skill/:part` into a known SkillPart (#3169). */
export const parseSkillPart = (
  raw: string | undefined,
): SkillPart | undefined => {
  if (!raw?.endsWith(".md")) return undefined;
  const stem = raw.slice(0, -3);
  return (SKILL_PARTS as readonly string[]).includes(stem)
    ? (stem as SkillPart)
    : undefined;
};

/** One on-demand skill part for this instance, memoized per isolate (#3169). */
export function renderSkillPart(
  part: SkillPart,
  env: SkillEnv,
): Promise<string> {
  const { plan, docBytes } = dataLimits(env);
  const hosted = env.HOSTED === "1" ? "h" : "";
  const spaces = spacesIn(env);
  const bus = busOn(env);
  const docs = docsAvailable(env);
  const key = `part|${part}|${env.ENVIRONMENT}|${env.APP_HOST}|${plan}|${docBytes}|${hosted}|${spaces ? "s" : ""}|${bus ? "b" : ""}|${docs ? "d" : ""}`;
  let p = memo.get(key);
  if (!p) {
    const tpl = spaces
      ? SKILL_PART_TEMPLATES[part]
      : SKILL_PART_TEMPLATES_NO_SPACES[part];
    p = fillSkillTokens(tpl, env, plan, docBytes, bus, docs).catch(
      (e: unknown) => {
        memo.delete(key);
        throw e;
      },
    );
    memo.set(key, p);
  }
  return p;
}

type EtagEnv = Pick<
  Env,
  "PLAN" | "DATA_DOC_BYTES" | "HOSTED" | "FEATURES" | "BUS_HUB" | "DOCS_PREVIEW"
>;

/**
 * ETag: version, plan and the template's hash (a git-less build keeps one
 * VERSION across template changes), plus the data-doc limit when
 * DATA_DOC_BYTES overrides the plan's, and "nospaces-" (with that
 * template's hash) without the spaces feature. The host is fixed per deploy.
 * A harness render adds a hash of its note, so a table or wording change is a
 * new ETag rather than a 304 under the same VERSION.
 */
export const skillEtag = (
  env: EtagEnv,
  harness?: Harness | undefined,
): string => {
  const { plan, docBytes } = dataLimits(env);
  const doc = docBytes === dataDocLimit(plan) ? "" : `-${docBytes}`;
  const hosted = env.HOSTED === "1" ? "-hosted" : "";
  const tpl = spacesIn(env) ? SKILL_HASH : `nospaces-${SKILL_HASH_NO_SPACES}`;
  const note = harnessNote(harness, busOn(env));
  const docs = docsAvailable(env) ? "-docs" : "";
  return `"${VERSION}-${plan}${doc}${hosted}${docs}-${tpl}${note ? `-${fnv(note)}` : ""}"`;
};

/** ETag for GET /skill/<part>.md (#3169). */
export const skillPartEtag = (part: SkillPart, env: EtagEnv): string => {
  const { plan, docBytes } = dataLimits(env);
  const doc = docBytes === dataDocLimit(plan) ? "" : `-${docBytes}`;
  const hosted = env.HOSTED === "1" ? "-hosted" : "";
  const tpl = spacesIn(env)
    ? SKILL_PART_HASHES[part]
    : `nospaces-${SKILL_PART_HASHES_NO_SPACES[part]}`;
  const docs = docsAvailable(env) ? "-docs" : "";
  return `"${VERSION}-${plan}${doc}${hosted}${docs}-${part}-${tpl}"`;
};

const serveMarkdown = async (
  c: Context<AppEnv>,
  etag: string,
  body: () => Promise<string>,
) => {
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
  return c.body(await body(), 200, headers);
};

export async function serveSkill(c: Context<AppEnv>) {
  if (!skillEnabled(c.env)) return c.notFound();
  const harness = parseHarness(c.req.query("harness"));
  return serveMarkdown(c, skillEtag(c.env, harness), () =>
    renderSkill(c.env, harness),
  );
}

/** GET /skill/<part>.md: on-demand skill parts (#3169). */
export async function serveSkillPart(c: Context<AppEnv>) {
  if (!skillEnabled(c.env)) return c.notFound();
  const part = parseSkillPart(c.req.param("part"));
  if (!part) return c.notFound();
  return serveMarkdown(c, skillPartEtag(part, c.env), () =>
    renderSkillPart(part, c.env),
  );
}
