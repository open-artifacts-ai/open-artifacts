// The bus clients the canary runs, one entry each: how to install it, the
// model secret it needs, how its pages connection is written (the token form
// from packages/shared agent-clients.ts, before `oa-bus install` adds the
// session proof), and how to start it headless with the canary's prompt.
//
// Wave 1 (agy S7): Claude Code, Codex, OpenCode and Pi. agy joins in wave 3.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ClientId = "claude" | "codex" | "opencode" | "pi";

export type Ctx = {
  /** The scratch HOME the client and oa-bus run in. */
  home: string;
  /** The project folder the session starts in. */
  work: string;
  /** The local server's /mcp. */
  mcpUrl: string;
  /** The member's token file (0600), as the dashboard's file form names it. */
  tokenFile: string;
  /** The model the run uses. */
  model: string;
  /** The process environment the client gets (HOME, PATH, the model secret). */
  env: Record<string, string>;
};

export type Launch = {
  cmd: string;
  args: string[];
  /** A TUI: run it inside a pseudo-terminal. */
  pty: boolean;
  /** Written to stdin once it starts; stdin stays open. */
  stdin?: string;
};

export type Client = {
  id: ClientId;
  label: string;
  /** The hub kind its sessions show as. */
  kind: string;
  /** The product a linked page shows (apps/server agent-display.ts). */
  product: string;
  /** Model API keys it needs; any one missing skips the client. */
  secrets: string[];
  /** The npm package and the version the nightly pins; the weekly leg takes latest. */
  npm: string;
  pinned: string;
  bin: string;
  /** The cheapest model that can call tools, unless CANARY_MODEL_<ID> says otherwise. */
  model: string;
  /** A message sent mid-turn lands in that turn (the daemon steers it). */
  steering: boolean;
  /** First-run settings and the pages connection, before `oa-bus install`. */
  prepare(ctx: Ctx): {
    run?: { cmd: string; args: string[]; stdin?: string }[];
  };
  start(ctx: Ctx, prompt: string): Launch;
};

const writeJson = (file: string, v: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
};
const writeText = (file: string, t: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, t, { mode: 0o600 });
};
const toml = (s: string) => JSON.stringify(s);
/** The file form's header helper (agent-clients.ts fileClients). */
const helper = (f: string) =>
  `T=$(cat ${f}) && printf '{"Authorization":"Bearer %s"}' "$T"`;

export const PAGES = "open-artifacts";

export const CLIENTS: Record<ClientId, Client> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    kind: "claude-code",
    product: "Claude Code",
    secrets: ["ANTHROPIC_API_KEY"],
    npm: "@anthropic-ai/claude-code",
    pinned: "2.1.332",
    bin: "claude",
    model: "haiku",
    // Peer messages reach Claude between turns; it has no steer path yet.
    steering: false,
    prepare(c) {
      const key = c.env.ANTHROPIC_API_KEY ?? "";
      writeJson(join(c.home, ".claude.json"), {
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        // Claude asks once before it uses a key from the environment.
        customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
        projects: { [c.work]: { hasTrustDialogAccepted: true } },
        mcpServers: {
          [PAGES]: {
            type: "http",
            url: c.mcpUrl,
            headersHelper: helper(c.tokenFile),
          },
        },
      });
      writeJson(join(c.home, ".claude/settings.json"), {
        skipDangerousModePermissionPrompt: true,
      });
      return {};
    },
    start(c, prompt) {
      return {
        cmd: "claude",
        args: [
          "--model",
          c.model,
          "--dangerously-skip-permissions",
          "-n",
          "canary-claude",
          prompt,
        ],
        pty: true,
      };
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    kind: "codex",
    product: "Codex",
    secrets: ["OPENAI_API_KEY"],
    npm: "@openai/codex",
    pinned: "0.171.0",
    bin: "codex",
    model: "gpt-5-mini",
    // The daemon steers a running thread through Codex's app-server socket.
    steering: true,
    prepare(c) {
      writeText(
        join(c.home, ".codex/config.toml"),
        [
          `model = ${toml(c.model)}`,
          `approval_policy = "never"`,
          `sandbox_mode = "danger-full-access"`,
          "",
          `[projects.${toml(c.work)}]`,
          `trust_level = "trusted"`,
          "",
          // The env-var token form: install swaps it for its proof proxy (codex-proof.ts).
          `[mcp_servers.${PAGES}]`,
          `url = ${toml(c.mcpUrl)}`,
          `bearer_token_env_var = "OA_TOKEN"`,
          "",
        ].join("\n"),
      );
      return {
        run: [
          {
            cmd: "codex",
            args: ["login", "--with-api-key"],
            stdin: c.env.OPENAI_API_KEY ?? "",
          },
        ],
      };
    },
    start(_c, prompt) {
      return { cmd: "codex", args: [prompt], pty: true };
    },
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    kind: "opencode",
    product: "OpenCode",
    secrets: ["ANTHROPIC_API_KEY"],
    npm: "opencode-ai",
    pinned: "2.0.32",
    bin: "opencode",
    model: "anthropic/claude-haiku-4-5",
    // A prompt sent mid-turn is queued for the next turn.
    steering: false,
    prepare(c) {
      writeJson(join(c.home, ".config/opencode/opencode.json"), {
        $schema: "https://opencode.ai/config.json",
        model: c.model,
        permission: "allow",
        autoupdate: false,
        mcp: {
          [PAGES]: {
            type: "remote",
            url: c.mcpUrl,
            oauth: false,
            headers: { Authorization: `Bearer {file:${c.tokenFile}}` },
          },
        },
      });
      return {};
    },
    start(_c, prompt) {
      return { cmd: "opencode", args: ["--prompt", prompt], pty: true };
    },
  },
  pi: {
    id: "pi",
    label: "Pi",
    kind: "pi",
    product: "Pi",
    secrets: ["ANTHROPIC_API_KEY"],
    npm: "@earendil-works/pi-coding-agent",
    pinned: "1.6.0",
    bin: "pi",
    model: "claude-haiku-4-5",
    // The extension hands a message to pi.sendMessage with deliverAs "steer".
    steering: true,
    prepare(c) {
      writeJson(join(c.home, ".pi/agent/mcp.json"), {
        mcpServers: {
          [PAGES]: {
            url: c.mcpUrl,
            headers: {
              Authorization: `!T=$(cat ${c.tokenFile}) && printf 'Bearer %s' "$T"`,
            },
          },
        },
      });
      return {};
    },
    start(c, prompt) {
      // RPC mode: no terminal, stays up between turns, takes prompts on stdin.
      return {
        cmd: "pi",
        args: [
          "--mode",
          "rpc",
          "--provider",
          "anthropic",
          "--model",
          c.model,
          "-n",
          "canary-pi",
        ],
        pty: false,
        stdin: `${JSON.stringify({ type: "prompt", message: prompt })}\n`,
      };
    },
  },
};

export const CLIENT_IDS = Object.keys(CLIENTS) as ClientId[];

/** Every model key any client takes. */
export const MODEL_KEYS = [
  ...new Set(Object.values(CLIENTS).flatMap((c) => c.secrets)),
];

/** `env` with no model key in it: for npm, wrangler and anything not the client. */
export function withoutModelKeys(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of MODEL_KEYS) delete out[k];
  return out;
}

/** The secrets `client` needs that `env` lacks. */
export const missingSecrets = (
  client: Client,
  env: Record<string, string | undefined>,
): string[] => client.secrets.filter((s) => !env[s]);

/**
 * What every client is told. Plain steps with markers the canary checks; the
 * fake clients in the tests follow the same words.
 */
export function canaryPrompt(title: string): string {
  return [
    "You are a test session for the Open Artifacts bus. Follow these rules exactly and do nothing else.",
    `1. Now: publish a page with the ${PAGES} publish_artifact tool, title "${title}", format "html", content "<p>canary</p>". Then end your turn.`,
    '2. When a bus message says "PING <word>", answer it at once, even in the middle of other work and before your next command: send its sender exactly "PONG <word>" with the bus send message tool. Then go on with what you were doing, or end your turn if there is nothing.',
    '3. When a bus message says "HOLD <word>", run the shell command `oa-canary-hold <word> 1`, then `oa-canary-hold <word> 2`. Each waits until it is released. Then send the sender exactly "DONE <word>" and end your turn.',
    "Never ask questions. Keep every message to one line.",
  ].join("\n");
}
