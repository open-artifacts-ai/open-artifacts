import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  daemonSocketPath,
  findAgy,
  readProc,
} from "@oa/bus-adapter-claude-code";
import { parseAgyMcp } from "@oa/bus-adapter-mcp-json";
import { daemonLinkProof } from "@oa/bus-ipc";
import {
  agyCallDigest,
  CodexDirectCallIdSchema,
  CodexThreadIdSchema,
  CodexToolNameSchema,
  canonicalArgsSha256,
} from "@oa/bus-protocol";
import { type Ctx, say } from "../context.ts";
import { isAgyInstanceEntry } from "../steps/agy-proof.ts";
import { readStdin } from "./agy-hello.ts";

export async function nativeCallWitness(text: string, config: string) {
  const e = JSON.parse(text);
  if (e?.hookEventName !== "PreToolUse" || e.toolCall?.name !== "call_mcp_tool")
    return;
  const { id, args } = e.toolCall;
  if (
    !CodexThreadIdSchema.safeParse(e.conversationId).success ||
    !CodexDirectCallIdSchema.safeParse(id).success ||
    !CodexToolNameSchema.safeParse(args?.ToolName).success ||
    typeof args.ServerName !== "string" ||
    !args.Arguments ||
    typeof args.Arguments !== "object" ||
    Array.isArray(args.Arguments)
  )
    return;
  const { mcpServers } = parseAgyMcp(readFileSync(config, "utf8"), config);
  if (
    !mcpServers ||
    typeof mcpServers !== "object" ||
    !Object.hasOwn(mcpServers, args.ServerName)
  )
    return;
  const entry = (mcpServers as Record<string, Record<string, unknown>>)[
    args.ServerName
  ];
  const url = entry?.serverUrl ?? entry?.url;
  if (
    typeof url !== "string" ||
    entry.command !== undefined ||
    entry.disabled === true
  )
    return;
  const { origin } = new URL(url);
  if (!isAgyInstanceEntry(entry, origin)) return;
  const argsHash = await canonicalArgsSha256(args.Arguments);
  const hash =
    argsHash &&
    (await agyCallDigest(
      origin,
      e.conversationId,
      id,
      args.ToolName,
      argsHash,
    ));
  if (hash) return { conversation: e.conversationId as string, hash };
}

export async function agyCall(ctx: Ctx) {
  try {
    const witness = await nativeCallWitness(
      await readStdin(),
      join(ctx.userHome, ".gemini/config/mcp_config.json"),
    );
    const pid = witness && findAgy(process.ppid, readProc);
    if (witness && pid)
      await daemonLinkProof({
        ...witness,
        pid,
        path: daemonSocketPath(ctx.home),
        agyCallSeen: true,
      });
  } catch {
    /* Missing local evidence leaves the OAuth call unlinked. */
  }
  say(ctx, "{}");
  return 0;
}
