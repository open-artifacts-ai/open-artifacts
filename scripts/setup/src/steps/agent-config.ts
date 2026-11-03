import { homeOf, patTokenFile } from "../secret-file.ts";
import type { Step } from "../step.ts";

const PLACEHOLDER = "<YOUR_TOKEN>";

type Snippet = {
  title: string;
  path: string | null;
  note: string;
  text: string;
};

/**
 * What setup prints. Claude Code, OpenCode and Cursor default to OAuth: the
 * snippet is only the MCP URL and the user signs in, so no token is ever in a
 * command line or config. A token is only for clients without OAuth: Codex
 * (`bearer_token_env_var`, env only), OpenCode's `{file:}` fallback and the
 * generic JSON. `tokenFile` is the absolute PAT file; undefined under --ci,
 * where no file exists.
 */
export function fileSnippets(
  name: string,
  url: string,
  tokenFile?: string,
): Record<string, Snippet> {
  const pretty = (v: unknown) => JSON.stringify(v, null, 2);
  const out: Record<string, Snippet> = {
    claudeCode: {
      title: "Claude Code",
      path: null,
      note: "then run /mcp in Claude Code and sign in; no token goes in the command",
      text: `claude mcp add --transport http -s user ${name} ${url}`,
    },
    cursor: {
      title: "Cursor",
      path: ".cursor/mcp.json",
      note: "Cursor opens a sign-in when it connects; no token goes in the file",
      text: pretty({ mcpServers: { [name]: { url } } }),
    },
    opencode: {
      title: "OpenCode",
      path: "opencode.json",
      note: `then run: opencode mcp auth ${name}; no token goes in the file`,
      text: pretty({
        $schema: "https://opencode.ai/config.json",
        mcp: { [name]: { type: "remote", url, enabled: true } },
      }),
    },
    codex: {
      title: "Codex CLI",
      path: "~/.codex/config.toml",
      note: tokenFile
        ? `Codex only reads the environment; launch it as: OA_TOKEN="$(cat ${tokenFile})" codex . Don't edit shell profiles.`
        : "Codex only reads the environment: launch it with OA_TOKEN set to a token from Settings → Agents. Don't edit shell profiles.",
      text: `[mcp_servers.${name}]\nurl = "${url}"\nbearer_token_env_var = "OA_TOKEN"`,
    },
  };
  if (tokenFile)
    out.opencodeToken = {
      title: "OpenCode (token file, for no OAuth)",
      path: "opencode.json",
      note: `only if OAuth is unavailable; OpenCode reads ${tokenFile} itself`,
      text: pretty({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [name]: {
            type: "remote",
            url,
            enabled: true,
            oauth: false,
            headers: { Authorization: `Bearer {file:${tokenFile}}` },
          },
        },
      }),
    };
  out.json = {
    title: "Generic JSON (no OAuth)",
    path: null,
    note: tokenFile
      ? `replace ${PLACEHOLDER} with the contents of ${tokenFile} yourself; keep this file out of git`
      : `replace ${PLACEHOLDER} with a token from Settings → Agents; keep this file out of git`,
    text: pretty({
      mcpServers: {
        [name]: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${PLACEHOLDER}` },
        },
      },
    }),
  };
  return out;
}

/** The snippet texts alone; the Connect agents doc shows exactly these (tokenFile `<token file>`). */
export const snippets = (
  name: string,
  url: string,
  tokenFile = "<token file>",
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(fileSnippets(name, url, tokenFile)).map(([k, v]) => [
      k,
      v.text,
    ]),
  );

export const agentConfig: Step = {
  name: "agent-config",
  always: true,
  runAfterFailureOf: ["healthcheck", "selftest"],
  check: async () => "todo",
  async apply(_state, ctx) {
    const url = `https://${ctx.opts.appHost}/mcp`;
    const ci = ctx.opts.ci;
    const file = patTokenFile(homeOf(ctx.deps.env), ctx.opts.appHost);
    // The token-file fallbacks only appear once the token exists.
    const tokenFile =
      !ci && (ctx.pat || ctx.fs.read(file) !== null) ? file : undefined;
    const pending = !ci && !tokenFile;
    const pendingNote =
      "no agent token yet; the token-file fallback snippets appear once setup has saved it";
    const all = fileSnippets(ctx.opts.name, url, tokenFile);
    const snippets = Object.fromEntries(
      Object.entries(all).map(([k, v]) => [k, v.text]),
    );
    const configs = Object.values(all).map((v) => ({
      client: v.title,
      path: v.path,
      note: v.note,
      snippet: v.text,
    }));
    const welcomeUrl = ctx.welcomeUrl;
    ctx.data = {
      url,
      ...(ci
        ? { tokenNote: "create a token in the dashboard (Settings → Agents)" }
        : pending
          ? { tokenNote: pendingNote }
          : {}),
      ...(tokenFile ? { tokenFile } : {}),
      snippets,
      configs,
      ...(welcomeUrl ? { welcomeUrl } : {}),
    };
    const welcome = welcomeUrl ? `\n  Welcome artifact: ${welcomeUrl}\n` : "";
    ctx.human =
      welcome +
      (ci
        ? "\n  Token: create a token in the dashboard (Settings → Agents); snippets never embed it."
        : pending
          ? `\n  Sign in with OAuth where the client supports it; ${pendingNote}.`
          : `\n  Sign in with OAuth where the client supports it. A token is saved to ${tokenFile} (don't read or print it); snippets never embed it.`) +
      Object.values(all)
        .map(
          (v) =>
            `\n  ${v.title} (${v.note}):\n${(v.path ? `# ${v.path}\n${v.text}` : v.text).replace(/^/gm, "    ")}`,
        )
        .join("\n");
    return undefined;
  },
};
