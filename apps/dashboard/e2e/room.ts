// A local doc room (e2e/doc-room.mjs) for one Playwright worker. Each worker
// gets its own port (base + parallelIndex), so specs run in parallel workers
// never share one; the page is pointed at it through window.__OA_DOC_WS
// (mock mode only, see roomServerUrl).
import { type ChildProcess, spawn } from "node:child_process";
import type { Page, TestInfo } from "@playwright/test";

const BASE = Number(process.env.OA_DOC_PORT) || 1235;
/** This worker's port. Tests of one worker run one at a time, so it is free. */
export const roomPort = (info: TestInfo) => BASE + info.parallelIndex;

/** What each room printed ("conn n", "closing code", ...), by process. */
export const roomLog = new WeakMap<ChildProcess, string[]>();

export async function startRoom(
  info: TestInfo,
  page: Page,
  args: string[],
): Promise<ChildProcess> {
  const port = roomPort(info);
  const room = spawn(process.execPath, ["e2e/doc-room.mjs", ...args], {
    env: { ...process.env, OA_DOC_PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines: string[] = [];
  roomLog.set(room, lines);
  room.stdout?.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) lines.push(l.trim());
  });
  await new Promise<void>((resolve, reject) => {
    room.once("error", reject);
    room.once("exit", (code) => reject(new Error(`doc room exited ${code}`)));
    room.stdout?.on("data", (d) => {
      if (String(d).includes("ready")) resolve();
    });
  });
  await page.addInitScript((p) => {
    (window as unknown as { __OA_DOC_WS: string }).__OA_DOC_WS =
      `ws://localhost:${p}`;
  }, port);
  return room;
}

export async function stopRoom(room: ChildProcess | undefined) {
  if (!room) return;
  room.removeAllListeners("exit");
  const closed = new Promise((r) => room.once("close", r));
  room.kill("SIGTERM");
  await closed;
}
