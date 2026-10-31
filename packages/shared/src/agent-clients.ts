// MCP client setup per agent and auth variant: one source for the dashboard's
// Settings → Agents tabs and the generated skill. Pure, dependency-free.

/** Placeholder in the generic token snippet. */
export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";
const DEFAULT_NAME = "open-artifacts";
const DEFAULT_VERIFY_TOOL = "publish_artifact";

export type Snippet = {
  agent: string;
  variant: "oauth" | "token";
  /** "text": prose, not a command or config (file form only). */
  language: "bash" | "json" | "toml" | "text";
  /** Where the config goes, shown above the code. */
  file?: string;
  code: string;
  /** One-line note for the token variant. */
  hint?: string;
  /** How to check it is connected (its tools/list). Never prints a token. */
  verify?: string;
  /** How to make the agent pick up a config change. */
  reload?: string;
};

export type AgentClientOpts = {
  /**
   * The PAT file (e.g. `~/.open-artifacts/<host slug>-pat-token`). With it,
   * each client gets one token mechanism that reads the file at connect
   * time: no env vars, nothing inlined, nothing printed. Cursor has none
   * (OAuth only). Without it: the dashboard's OA_TOKEN env-var snippets.
   */
  tokenFile?: string;
  /** The MCP server name in every snippet. Default "open-artifacts". */
  name?: string;
  /** The tool the generic verify text names. Default "publish_artifact". */
  verifyTool?: string;
};

/** POSIX shell single-quoting. */
const sh = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
/** TOML basic string: JSON escapes are valid TOML, plus DEL. */
const toml = (s: string) => JSON.stringify(s).replaceAll("\x7f", "\\u007F");
const json = (v: unknown) => JSON.stringify(v, null, 2);

const cursorVerifyOauth = (name: string) =>
  `Find ${name} under Customize in the sidebar. When Cursor asks you to sign in, finish in your browser. Cursor then lists its tools.`;
const CURSOR_RELOAD =
  "Turn the server off and on again in Customize, or restart Cursor.";
const genericVerify = (name: string, tool: string) =>
  `Ask your AI agent to list the ${name} tools. You should see ${tool}.`;
const GENERIC_RELOAD = "Restart your AI agent, or reload its MCP servers.";
const CLAUDE_RELOAD =
  "Start a new Claude Code session, or reconnect from `/mcp`.";
const CODEX_RELOAD =
  "Restart Codex (the CLI, IDE extension or app). It reads its config when it starts.";
const OPENCODE_RELOAD = "Restart OpenCode. It reads its config when it starts.";

/**
 * MCP client snippets per agent and auth variant: every oauth variant first,
 * then the token variants, agents in a fixed order (Claude Code, Codex CLI,
 * Cursor, OpenCode, Generic). Never embeds a token. Pure.
 */
export function agentClients(
  mcpUrl: string,
  opts: AgentClientOpts = {},
): Snippet[] {
  const name = opts.name ?? DEFAULT_NAME;
  const verify = genericVerify(name, opts.verifyTool ?? DEFAULT_VERIFY_TOOL);
  return opts.tokenFile
    ? fileClients(mcpUrl, opts.tokenFile, name, verify)
    : envClients(mcpUrl, name, verify);
}

/** The skill's form: OAuth first; tokens read the file at connect time. */
function fileClients(
  url: string,
  f: string,
  name: string,
  verifyText: string,
): Snippet[] {
  /** A shell command that prints the auth header JSON from the file. */
  // Fails (non-zero, no header) when the file is missing.
  const helper = `T=$(cat ${f}) && printf '{"Authorization":"Bearer %s"}' "$T"`;
  const oauth: Snippet[] = [
    {
      agent: "Claude Code",
      variant: "oauth",
      language: "bash",
      code: `claude mcp add --transport http -s user ${name} ${sh(url)}`,
      verify: `In a Claude Code session, run \`/mcp\` (or \`claude mcp login ${name}\`) and sign in with your browser. Then \`claude mcp list\` shows ${name} as connected.`,
      reload: CLAUDE_RELOAD,
    },
    {
      agent: "Codex CLI",
      variant: "oauth",
      language: "bash",
      code: `codex mcp add ${name} --url ${sh(url)}`,
      verify: `Run \`codex mcp login ${name}\` to sign in with your browser. Then \`codex mcp list\` shows ${name}.`,
      reload: CODEX_RELOAD,
    },
    {
      agent: "Cursor",
      variant: "oauth",
      language: "json",
      file: "~/.cursor/mcp.json",
      code: json({ mcpServers: { [name]: { url } } }),
      verify: cursorVerifyOauth(name),
      reload: CURSOR_RELOAD,
    },
    {
      agent: "OpenCode",
      variant: "oauth",
      language: "json",
      file: "opencode.json",
      code: json({ mcp: { [name]: { type: "remote", url } } }),
      verify: `Run \`opencode mcp auth ${name}\` to sign in with your browser. Then \`opencode mcp list\` shows ${name}.`,
      reload: OPENCODE_RELOAD,
    },
    {
      agent: "Generic",
      variant: "oauth",
      language: "json",
      code: json({ mcpServers: { [name]: { type: "http", url } } }),
      verify: verifyText,
      reload: GENERIC_RELOAD,
    },
  ];
  const token: Snippet[] = [
    {
      agent: "Claude Code",
      variant: "token",
      language: "bash",
      code: `claude mcp add-json -s user ${name} ${sh(
        JSON.stringify({ type: "http", url, headersHelper: helper }),
      )}`,
      hint: `Claude Code reads the token from ${f} each time it connects. It's added for your user, so it works in every project.`,
      verify: `Run \`claude mcp list\`. It shows ${name} as connected.`,
      reload: CLAUDE_RELOAD,
    },
    {
      agent: "Codex CLI",
      variant: "token",
      language: "toml",
      file: "~/.codex/config.toml",
      code: `[mcp_servers.${name}]\nurl = ${toml(url)}\nhttp_headers_helper = ${toml(helper)}`,
      hint: "This needs Codex 0.163 or later. On older versions, use OAuth.",
      verify: `Run \`codex mcp list\`. It shows ${name}.`,
      reload: CODEX_RELOAD,
    },
    {
      agent: "OpenCode",
      variant: "token",
      language: "json",
      file: "opencode.json",
      code: json({
        mcp: {
          [name]: {
            type: "remote",
            url,
            oauth: false,
            headers: { Authorization: `Bearer {file:${f}}` },
          },
        },
      }),
      hint: "OpenCode reads the token file even when it runs in the background. Don't run `opencode service` from inside an OpenCode session, because it restarts the server.",
      verify: `Run \`opencode mcp list\`. It shows ${name} as connected.`,
      reload: OPENCODE_RELOAD,
    },
    {
      agent: "Generic",
      variant: "token",
      language: "text",
      code: `Use your client's option to read the token from ${f} when it connects. If it has none, use OAuth. Never paste the token into a config file.`,
      verify: verifyText,
      reload: GENERIC_RELOAD,
    },
  ];
  return [...oauth, ...token];
}

/**
 * The dashboard's form (unchanged until Frontend switches to tokenFile):
 * token variants read `OA_TOKEN` from the environment.
 */
function envClients(
  mcpUrl: string,
  name: string,
  verifyText: string,
): Snippet[] {
  const out: Snippet[] = [];
  for (const variant of ["oauth", "token"] as const) {
    const t = variant === "token";
    const add = (s: Omit<Snippet, "variant">) =>
      out.push({
        agent: s.agent,
        variant,
        language: s.language,
        code: s.code,
        ...(s.file ? { file: s.file } : {}),
        ...(t && s.hint ? { hint: s.hint } : {}),
        ...(s.verify ? { verify: s.verify } : {}),
        ...(s.reload ? { reload: s.reload } : {}),
      });
    add({
      agent: "Claude Code",
      language: "bash",
      code: t
        ? `read -rs OA_TOKEN
claude mcp add --transport http ${name} ${sh(mcpUrl)} --header "Authorization: Bearer $OA_TOKEN"
unset OA_TOKEN`
        : `claude mcp add --transport http ${name} ${sh(mcpUrl)}`,
      hint: "Paste your token when prompted. It stays hidden as you type, and Claude Code saves it in its own config.",
      verify: t
        ? `Run \`claude mcp list\`. It shows ${name} as connected.`
        : `In a Claude Code session, run \`/mcp\`, pick ${name} and sign in with your browser. Claude Code then lists its tools.`,
      reload: CLAUDE_RELOAD,
    });
    add({
      agent: "Codex CLI",
      language: "toml",
      code: `[mcp_servers.${name}]\nurl = ${toml(mcpUrl)}${t ? `\nbearer_token_env_var = "OA_TOKEN"` : ""}`,
      file: "~/.codex/config.toml",
      hint: "Export OA_TOKEN in the shell that starts Codex.",
      verify: t
        ? `Run \`codex mcp list\`. It shows ${name}.`
        : `Run \`codex mcp login ${name}\` to sign in with your browser. Then \`codex mcp list\` shows ${name}.`,
      reload: "Restart Codex. It reads config.toml when it starts.",
    });
    add({
      agent: "Cursor",
      language: "json",
      code: json({
        mcpServers: {
          [name]: {
            url: mcpUrl,
            ...(t
              ? { headers: { Authorization: "Bearer ${env:OA_TOKEN}" } }
              : {}),
          },
        },
      }),
      file: "~/.cursor/mcp.json",
      hint: "Export OA_TOKEN before you open Cursor.",
      verify: t
        ? `Customize in the sidebar shows ${name} turned on, with its tools.`
        : cursorVerifyOauth(name),
      reload: CURSOR_RELOAD,
    });
    add({
      agent: "OpenCode",
      language: "json",
      code: json({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [name]: {
            type: "remote",
            url: mcpUrl,
            enabled: true,
            ...(t
              ? {
                  oauth: false,
                  headers: { Authorization: "Bearer {env:OA_TOKEN}" },
                }
              : {}),
          },
        },
      }),
      file: "opencode.json",
      hint: "Export OA_TOKEN before you start OpenCode. If it isn't set, OpenCode sends an empty token.",
      verify: t
        ? `Run \`opencode mcp list\`. It shows ${name} as connected.`
        : `Run \`opencode mcp auth ${name}\` to sign in with your browser. Then \`opencode mcp list\` shows ${name}.`,
      reload: OPENCODE_RELOAD,
    });
    add({
      agent: "Generic",
      language: "json",
      code: json({
        mcpServers: {
          [name]: {
            type: "http",
            url: mcpUrl,
            ...(t
              ? { headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } }
              : {}),
          },
        },
      }),
      hint: `If your client can read the token from a file or an environment variable, use that. If it can't, replace ${TOKEN_PLACEHOLDER} with your token and keep this file out of git.`,
      verify: verifyText,
      reload: GENERIC_RELOAD,
    });
  }
  return out;
}
