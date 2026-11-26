// A stand-in `pi` for the canary's own tests and local proof: no model, no
// network but the local server. It loads the REAL extension `oa-bus install`
// wrote (~/.pi/agent/extensions/oa-bus.ts) into a small host that plays Pi's
// part: session_start, registered tools, registerMcpServer and sendMessage.
// Its "model" follows the canary prompt's rules word for word, so the daemon,
// the hub, the link proof and the pages /mcp are all the real ones.
//
//   pi --version            -> 1.6.0
//   pi --mode rpc ...       -> the session; prompts come on stdin as JSON lines
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type Json = Record<string, unknown>;
type Tool = {
  name: string;
  execute: (
    id: string,
    params: Json,
    s: unknown,
    u: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
};

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("1.6.0");
  process.exit(0);
}
if (!argv.includes("rpc")) process.exit(0);

const tools = new Map<string, Tool>();
const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
let pages: { name: string; config: Json } | undefined;
const ctx = {
  cwd: process.cwd(),
  sessionManager: {
    getSessionId: () => "c0ffee00-0000-4000-8000-000000000001",
    getSessionName: () => "canary-pi",
  },
};

/** The turn: one item at a time; messages that arrive mid-tool wait for the tool boundary. */
const queue: (() => Promise<void>)[] = [];
let busy = false;
let inTool = false;
const steered: { content: string; from: string }[] = [];
const pump = async () => {
  if (busy) return;
  busy = true;
  while (queue.length > 0) await queue.shift()?.();
  busy = false;
};

const say = (line: string) => process.stdout.write(`${line}\n`);

async function send(to: string, text: string) {
  const t = tools.get("oabus_send_message");
  if (!t) throw new Error("no oabus_send_message tool");
  await t.execute("call", { to, text }, undefined, undefined, ctx);
  say(`sent ${to}: ${text}`);
}

const hold = (word: string, n: number) =>
  new Promise<void>((resolve) => {
    inTool = true;
    const p = spawn("oa-canary-hold", [word, String(n)], { stdio: "ignore" });
    p.on("exit", () => {
      inTool = false;
      resolve();
    });
  });

/** Answers one bus message by the prompt's rules. */
async function onMessage(content: string, from: string) {
  const ping = /PING (\w+)/.exec(content);
  if (ping) return send(from, `PONG ${ping[1]}`);
  const h = /HOLD (\w+)/.exec(content);
  if (h) {
    const w = h[1] as string;
    // CANARY_FAKE_BREAK=steer: what was steered in waits for the next turn.
    const steers = process.env.CANARY_FAKE_BREAK !== "steer";
    await hold(w, 1);
    // The tool boundary: what was steered in during the tool is read now.
    if (steers)
      for (const m of steered.splice(0)) await onMessage(m.content, m.from);
    await hold(w, 2);
    if (steers)
      for (const m of steered.splice(0)) await onMessage(m.content, m.from);
    await send(from, `DONE ${w}`);
    for (const m of steered.splice(0)) await onMessage(m.content, m.from);
    return;
  }
}

/** One JSON-RPC call to the pages /mcp, with the registered entry's headers. */
async function mcp(
  session: { id?: string },
  body: Json,
): Promise<Json | undefined> {
  const cfg = pages?.config ?? {};
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const [k, v] of Object.entries((cfg.headers as Json) ?? {})) {
    const s = String(v);
    headers[k] = s.startsWith("!")
      ? execFileSync("sh", ["-c", s.slice(1)], { encoding: "utf8" }).trim()
      : s;
  }
  if (session.id) headers["mcp-session-id"] = session.id;
  const res = await fetch(String(cfg.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  session.id = res.headers.get("mcp-session-id") ?? session.id;
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `mcp ${String(body.method)}: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  if (!text) return undefined;
  const data = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5))
        .join("");
  return data ? (JSON.parse(data) as Json) : undefined;
}

async function publish(title: string) {
  // The proof header comes once the session's link is bound; a real Pi
  // connects when it first needs the server, which is after that too.
  const deadline = Date.now() + 30_000;
  while (
    !JSON.stringify(pages?.config ?? {}).includes("Proof") &&
    Date.now() < deadline
  )
    await new Promise((r) => setTimeout(r, 100));
  if (!pages) throw new Error("no pages server registered");
  const s: { id?: string } = {};
  await mcp(s, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pi", version: "1.6.0" },
    },
  });
  await mcp(s, { jsonrpc: "2.0", method: "notifications/initialized" });
  const r = await mcp(s, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "publish_artifact",
      arguments: { title, format: "html", content: "<p>canary</p>" },
    },
  });
  say(`published ${title}: ${JSON.stringify(r).slice(0, 200)}`);
}

const pi = {
  registerTool: (t: Tool) => tools.set(t.name, t),
  on: (event: string, h: (e: unknown, c: unknown) => unknown) =>
    handlers.set(event, [...(handlers.get(event) ?? []), h]),
  registerMcpServer: (name: string, config: Json) => {
    pages = { name, config };
  },
  unregisterMcpServer: () => {
    pages = undefined;
  },
  sendMessage: (m: {
    customType: string;
    content: string;
    details?: { from?: string };
  }) => {
    if (m.customType !== "oa_bus") return;
    const from = String(m.details?.from ?? "");
    if (inTool) steered.push({ content: m.content, from });
    else {
      queue.push(async () => {
        await onMessage(m.content, from).catch((e) =>
          say(`error: ${(e as Error).message}`),
        );
      });
      void pump();
    }
  },
};

const ext = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"),
  "extensions/oa-bus.ts",
);
const mod = (await import(pathToFileURL(ext).href)) as {
  default: (p: unknown) => void;
};
mod.default(pi);
for (const h of handlers.get("session_start") ?? []) await h({}, ctx);
say("session started");

createInterface({ input: process.stdin }).on("line", (line) => {
  let cmd: Json;
  try {
    cmd = JSON.parse(line) as Json;
  } catch {
    return;
  }
  if (cmd.type !== "prompt") return;
  const title = /title "([^"]+)"/.exec(String(cmd.message))?.[1];
  if (title) {
    queue.push(async () => {
      await publish(title).catch((e) => say(`error: ${(e as Error).message}`));
    });
    void pump();
  }
});
