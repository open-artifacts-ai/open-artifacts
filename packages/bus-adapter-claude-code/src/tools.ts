import {
  BUS_CMD,
  cleanStatusLabel,
  type DaemonClient,
  earlierStatusText,
  excerptOf,
  FOLLOW_OLD_DAEMON,
  followingText,
  followText,
  linkedLiveNamespace,
  movedName,
  receiptText,
  rosterLine,
  SetStatus,
  STATUS_COPY,
  selfText,
  statusLabelTooLong,
  statusSetText,
  unfollowText,
} from "@oa/bus-ipc";

/** LIMITS.maxLabelChars: a status label's limit, in code points. */
const MAX_LABEL_CHARS = 64;

const none = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const TOOLS = [
  {
    name: "list_agents",
    description:
      "List the agents you can message, in your Open Artifacts bus namespace and linked ones.",
    inputSchema: none,
  },
  {
    name: "send_message",
    description: "Send a message to another agent by name.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        text: { type: "string" },
        to_namespace: {
          type: "string",
          description:
            "The recipient's namespace, when the target name exists in several: a global agent's, or a linked project's.",
        },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch",
    description: "Fetch the full body of an oversized message by id.",
    inputSchema: {
      type: "object",
      properties: { msg_id: { type: "string" } },
      required: ["msg_id"],
      additionalProperties: false,
    },
  },
  {
    name: "self",
    description: `Your own Open Artifacts bus agent entry and bus name. To become global, ask the user to approve running \`${BUS_CMD} global add <your start dir>\`, then restart.`,
    inputSchema: none,
  },
  {
    name: "set_status",
    description:
      "Tell the user what you are doing: working, idle, blocked, or waiting_on_owner (waiting on the user), with an optional short label. The user sees it labelled as your own report.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["working", "idle", "blocked", "waiting_on_owner"],
        },
        label: {
          type: "string",
          maxLength: MAX_LABEL_CHARS,
          description: "What you are on, in a few words.",
        },
      },
      required: ["state"],
      additionalProperties: false,
    },
  },
  {
    name: "follow",
    description:
      "Follow an Open Artifacts artifact, by id or link, to get a notice when it changes.",
    inputSchema: {
      type: "object",
      properties: { artifact: { type: "string" } },
      required: ["artifact"],
      additionalProperties: false,
    },
  },
  {
    name: "unfollow",
    description: "Stop following an artifact, by id or link.",
    inputSchema: {
      type: "object",
      properties: { artifact: { type: "string" } },
      required: ["artifact"],
      additionalProperties: false,
    },
  },
  {
    name: "following",
    description: "List the artifacts you follow.",
    inputSchema: none,
  },
] as const;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const text = (t: string, isError?: boolean): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError === undefined ? {} : { isError }),
});

/** Older daemons send only `live`. */
const queued = (a: { live: boolean; state?: "live" | "queued" | "away" }) =>
  (a.state ?? (a.live ? "live" : "queued")) === "queued";

/**
 * The sender is the connection's attested session; a `from` argument is never
 * read. Late deliveries the daemon hands back ride after the result, each
 * after a blank line.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  client: DaemonClient,
  /** Aborted when the harness cancels the call: closing the connection makes the daemon tell its outcome as a notice. */
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (signal?.aborted) {
    client.close();
    return text("oa-bus: the tool call was cancelled.", true);
  }
  signal?.addEventListener("abort", () => client.close(), { once: true });
  const late: string[] = [];
  const request: Request = async (f) => {
    const r = await client.request({ ...f, late: true });
    if (r.type !== "status" && "late" in r && r.late) late.push(...r.late);
    return r;
  };
  const out = await run(name, args, request);
  if (!late.length) return out;
  const [first, ...rest] = out.content;
  return {
    ...out,
    content: [
      { type: "text", text: [first?.text ?? "", ...late].join("\n\n") },
      ...rest,
    ],
  };
}

type Request = DaemonClient["request"];

async function run(
  name: string,
  args: Record<string, unknown>,
  request: Request,
): Promise<ToolResult> {
  try {
    if (name === "set_status") return await statusTool(args, request);
    if (name === "follow" || name === "unfollow" || name === "following")
      return await followTool(name, args, request);
    if (name === "list_agents") {
      const r = await request({ type: "list" });
      if (r.type !== "roster") return failed(r);
      const now = Date.now();
      return text(
        r.agents.length
          ? r.agents
              .map((a) =>
                rosterLine(
                  {
                    ...a,
                    queued: queued(a),
                    away: a.state === "away" ? (a.since ?? "") : undefined,
                  },
                  now,
                ),
              )
              .join("\n")
          : "No agents in your namespace and linked ones.",
      );
    }
    if (name === "send_message") {
      const to = String(args.to ?? "");
      const body = String(args.text ?? "");
      if (!to || !body) return text("oa-bus: to and text are required", true);
      const namespace =
        typeof args.to_namespace === "string" && args.to_namespace
          ? args.to_namespace
          : undefined;
      const r = await request({
        type: "send",
        to,
        body,
        ...(namespace ? { namespace } : {}),
      });
      if (r.type !== "receipt") return failed(r);
      // The daemon's copy for a send it gave up on (C16): verbatim, not an error.
      if (r.text) return text(r.text, false);
      const n =
        r.reason === "ambiguous" ? await namespacesOf(to, request) : undefined;
      const moved =
        r.reason === "revoked"
          ? await movedTo(to, namespace, request)
          : undefined;
      const linked =
        (r.reason === "closed" || r.reason === "revoked") && !namespace
          ? await linkedLive(to, request)
          : undefined;
      return text(
        receiptText(r, to, n, excerptOf(body), moved, linked),
        r.state === "refused" || r.state === "expired",
      );
    }
    if (name === "fetch") {
      const r = await request({
        type: "fetch",
        msg_id: String(args.msg_id ?? ""),
      });
      return r.type === "body" ? text(r.body, false) : failed(r);
    }
    if (name === "self") {
      const r = await request({ type: "self", row: true });
      if (r.type !== "agent") return failed(r);
      return text(selfText(r.agent));
    }
    return text(`oa-bus: unknown tool ${name}`, true);
  } catch (e) {
    // A daemon that is down must not take the MCP server with it.
    return text(`oa-bus: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

/**
 * set_status. Arguments are checked with the daemon's own schema first.
 * Refusals are the daemon's copy, as-is.
 */
async function statusTool(
  args: Record<string, unknown>,
  request: Request,
): Promise<ToolResult> {
  // Cleaned as a machine label is; empty is no label.
  const label =
    typeof args.label === "string" ? cleanStatusLabel(args.label) : args.label;
  const chars = typeof label === "string" ? [...label].length : 0;
  if (chars > MAX_LABEL_CHARS) return text(statusLabelTooLong(chars), true);
  const frame = SetStatus.safeParse({
    v: 1,
    id: "0",
    type: "set_status",
    state: args.state,
    ...(label === undefined || label === "" ? {} : { label }),
  });
  if (!frame.success) {
    const issue = frame.error.issues[0];
    if (issue?.path[0] === "label")
      return text("oa-bus: label: the status label must be text", true);
    return text(
      `oa-bus: ${String(issue?.path[0] ?? "arguments")}: ${issue?.message ?? "invalid"}`,
      true,
    );
  }
  const { v: _v, id: _id, ...f } = frame.data;
  const r = await request(f);
  if (r.type === "status_set") {
    const done = statusSetText(f.state, f.label);
    return text(
      r.earlier ? `${done}\n\n${earlierStatusText(r.earlier.message)}` : done,
      false,
    );
  }
  if (r.type !== "error") return failed(r);
  if (r.code === "bad_frame" && r.message !== STATUS_COPY.bad_frame)
    return text(STATUS_COPY.bad_frame, true);
  return text(r.message, true);
}

/** follow, unfollow and following (#1317). Refusals are the hub's or daemon's copy, as-is. */
async function followTool(
  name: "follow" | "unfollow" | "following",
  args: Record<string, unknown>,
  request: Request,
): Promise<ToolResult> {
  const artifact =
    typeof args.artifact === "string" ? args.artifact.trim() : "";
  if (name !== "following" && !artifact)
    return text("oa-bus: artifact is required (an id or a link)", true);
  const r =
    name === "following"
      ? await request({ type: "following" })
      : await request({ type: name, artifact });
  if (r.type === "followed") return text(followText(r.url));
  if (r.type === "unfollowed") return text(unfollowText(r.removed, artifact));
  if (r.type === "follows") return text(followingText(r.follows));
  if (r.type === "error" && r.code === "bad_frame")
    return text(FOLLOW_OLD_DAEMON, true);
  return failed(r);
}

/** How many namespaces hold `name`; undefined when the roster is unavailable. */
async function namespacesOf(
  name: string,
  request: Request,
): Promise<number | undefined> {
  try {
    const r = await request({ type: "list" });
    if (r.type !== "roster") return undefined;
    return new Set(
      r.agents.filter((a) => a.name === name).map((a) => a.namespace),
    ).size;
  } catch {
    return undefined;
  }
}

/**
 * #1448: the live `<name>-N` a revoked name moved to, in `namespace` when the
 * send named one; undefined when none or the roster is unavailable.
 */
async function movedTo(
  name: string,
  namespace: string | undefined,
  request: Request,
): Promise<string | undefined> {
  try {
    const r = await request({ type: "list" });
    if (r.type !== "roster") return undefined;
    return movedName(
      name,
      r.agents
        .filter((a) => namespace === undefined || a.namespace === namespace)
        .map((a) => a.name),
    );
  } catch {
    return undefined;
  }
}

/** #1567: the linked namespace with a live agent called `name`; undefined when none or the roster is unavailable. */
async function linkedLive(
  name: string,
  request: Request,
): Promise<string | undefined> {
  try {
    const r = await request({ type: "list" });
    if (r.type !== "roster") return undefined;
    return linkedLiveNamespace(name, r.agents);
  } catch {
    return undefined;
  }
}

function failed(r: { type: string; message?: string }): ToolResult {
  return text(`oa-bus: ${r.type === "error" ? r.message : r.type}`, true);
}
