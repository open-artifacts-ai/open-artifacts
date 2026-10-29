// GET /llms.txt on the app host: this instance's setup guide for any AI agent
// (Connect, Restart, Verify, Troubleshoot). All of its wording lives in this
// file. The per-client blocks come from agentClients (@oa/shared), the same
// source as the dashboard's Settings → Agents tabs, so the two can't drift.
// Public: the instance's address and nothing else (no user data, no tokens).
// Rendered once per isolate (APP_HOST is fixed per deploy): no D1, no session.
import {
  agentClients,
  hostSlug,
  PRODUCT_NAME,
  type Snippet,
  secretFile,
} from "@oa/shared";
import type { Context } from "hono";
import type { Env } from "../env.js";
import type { AppEnv } from "../http/middleware.js";
import { VERSION } from "../version.gen.js";
import { SKILL_PATH, skillEnabled } from "./skill.js";
import { skillOrigin } from "./skill-common.js";

export const LLMS_PATH = "/llms.txt";

/**
 * The Claude Code plugin block. Off until the plugin is published: while
 * off, the guide leaves the block out entirely.
 */
export const CLAUDE_PLUGIN_ENABLED = false;

/** The plugin's marketplace, name and the option that points it at an instance. */
export const CLAUDE_PLUGIN = {
  marketplace: "open-artifacts-ai/open-artifacts",
  name: "open-artifacts",
  option: "instance_url",
} as const;

/** The MCP server name every client snippet registers. */
const SERVER_NAME = "open-artifacts";

type LlmsEnv = Pick<Env, "APP_HOST" | "SKILL_MD">;

/** The guide's inputs for one instance. */
export const llmsInputs = (host: string) => {
  const origin = skillOrigin(host);
  const mcpUrl = `${origin}/mcp`;
  const tokenFile = secretFile("pat", { hostSlug: hostSlug(host) });
  // The dashboard's call (Settings → Agents). Token variants read the file at
  // connect time (headersHelper, http_headers_helper, {file:}): never a token.
  const all = agentClients(mcpUrl, { tokenFile });
  const clients = all.filter((s) => s.variant === "oauth");
  const tokens = all.filter((s) => s.variant === "token");
  return { origin, mcpUrl, tokenFile, clients, tokens };
};

const intro = (s: Snippet) =>
  s.file
    ? `Add this to \`${s.file}\` (create the file if it doesn't exist, and keep any servers already in it):`
    : s.language === "bash"
      ? "Run:"
      : "Add this to your client's MCP configuration (keep any servers already in it):";

const clientBlock = (s: Snippet) =>
  [
    `### ${s.agent}`,
    intro(s),
    `\`\`\`${s.language}`,
    s.code,
    "```",
    `Then: ${s.verify}`,
  ].join("\n");

/** One client's token-file setup, or a note when it has none (Cursor). */
const tokenBlock = (agent: string, s: Snippet | undefined) =>
  s
    ? [
        `#### ${agent}`,
        ...(s.language === "text"
          ? [s.code]
          : [intro(s), `\`\`\`${s.language}`, s.code, "```"]),
        ...(s.hint ? [`Note: ${s.hint}`] : []),
        `Then: ${s.verify}`,
      ].join("\n")
    : `#### ${agent}\nNo token-file option: sign in through the browser as above.`;

const pluginBlock = (origin: string) => {
  const { marketplace, name, option } = CLAUDE_PLUGIN;
  return `### Claude Code: prefer the plugin
If you are Claude Code, install the ${PRODUCT_NAME} plugin instead of the plain server above. It adds the server and the skill together, and points them at this instance through the plugin's own option:
\`\`\`bash
claude plugin marketplace add ${marketplace}
claude plugin install ${name}
printf '{"${option}":"${origin}"}' | claude plugin configure ${name} --values-stdin
\`\`\`
Then run \`claude plugin configure ${name}\` and check \`${option}\` shows ${origin}. If the plugin can't be installed, use the Claude Code section above.

`;
};

/** The guide for `host`. `plugin` and `skill` default to the live settings. */
export function renderLlms(
  host: string,
  opts: { plugin?: boolean; skill?: boolean } = {},
): string {
  const plugin = opts.plugin ?? CLAUDE_PLUGIN_ENABLED;
  const skill = opts.skill ?? true;
  const { origin, mcpUrl, tokenFile, clients, tokens } = llmsInputs(host);
  const verifySteps = [
    "List the server's tools. You should see tools such as `publish_artifact` and `list_artifacts`. If the list is empty or you get 401, see Troubleshoot.",
    'Optional: publish a tiny test artifact with `visibility: "private"` (title "setup check"), confirm you get back a link, then delete it right away with `delete_artifact`. If the delete fails, tell the person, with the link, so they can delete it.',
    ...(skill
      ? [
          `Read ${origin}${SKILL_PATH} and follow it from now on. It explains how to publish and work with artifacts on this instance.`,
        ]
      : []),
  ];
  return `# ${PRODUCT_NAME} at ${host}

You are setting up ${PRODUCT_NAME} for the person you're working with. Do every step below yourself. Never ask them to paste a token, password or secret into this chat. Sign-in happens in their browser.

Server address (MCP, streamable HTTP): ${mcpUrl}

## Connect

Use the section for the client you are running in: you know which one that is. Only if the person asks you to set up a different client, find it with \`which claude codex cursor opencode\`; if none fits, use Generic.

${clients.map(clientBlock).join("\n\n")}

${plugin ? pluginBlock(origin) : ""}If a client can only use a token, never ask the person for it and never paste it into chat. The person creates it under Personal access tokens at ${origin}/settings/agents and saves it to \`${tokenFile}\` (mode 0600). If they can't open that page, they ask their admin. Your config reads the file at connect time:

${clients
  .map((o) =>
    tokenBlock(
      o.agent,
      tokens.find((t) => t.agent === o.agent),
    ),
  )
  .join("\n\n")}

## Restart

${clients.map((s) => `- ${s.agent}: ${s.reload}`).join("\n")}

## Verify

${verifySteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Tell the person: "${PRODUCT_NAME} is connected." Include the address ${origin}.

## Troubleshoot

- The browser sign-in never opened: start it from the client (for example \`claude mcp login ${SERVER_NAME}\` or \`codex mcp login ${SERVER_NAME}\`), then ask the person to approve it in the browser.
- 401 or "unauthorized" after it worked before: the sign-in expired or was revoked. Sign in again the same way. Don't switch to a token unless the person asks.
- 404 or "not found" on the server address: check it is exactly the address above, including \`/mcp\`: ${mcpUrl}
- The tools don't appear: restart the client as in Restart, then list the tools again.
- Still stuck: tell the person what you ran and the exact error, without any token or secret in it.
`;
}

const memo = new Map<string, Promise<{ body: string; etag: string }>>();

const sha8 = async (s: string): Promise<string> => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/** The body and its ETag (version plus the body's hash), memoized per isolate. */
export function llmsDoc(env: LlmsEnv): Promise<{ body: string; etag: string }> {
  const skill = skillEnabled(env);
  const key = `${env.APP_HOST}|${skill ? "s" : ""}`;
  let p = memo.get(key);
  if (!p) {
    const body = renderLlms(env.APP_HOST, { skill });
    p = sha8(body).then((h) => ({ body, etag: `"${VERSION}-llms-${h}"` }));
    // A failure is not memoized: the next request tries again.
    p = p.catch((e: unknown) => {
      memo.delete(key);
      throw e;
    });
    memo.set(key, p);
  }
  return p;
}

export async function serveLlms(c: Context<AppEnv>) {
  const { body, etag } = await llmsDoc(c.env);
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
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
  return c.body(body, 200, headers);
}
