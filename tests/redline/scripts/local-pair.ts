// Boots two local installs (src/local-pair.ts), runs a command against them
// with REDLINE_TARGETS set, then tears everything down.
//   node --experimental-strip-types scripts/local-pair.ts [--gate] [-- cmd ...]
// Default command: the live suite (scripts/redline.ts). Bounded by
// REDLINE_LOCAL_TIMEOUT_MS (default 15 min); SIGINT, SIGTERM, errors and the
// timeout all stop only the process groups this script spawned.
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  groupMembers,
  type LocalPair,
  startLocalPair,
} from "../src/local-pair.ts";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep === -1 ? argv : argv.slice(0, sep);
const cmd =
  sep === -1
    ? [
        process.execPath,
        "--experimental-strip-types",
        join(import.meta.dirname, "redline.ts"),
        ...own,
      ]
    : argv.slice(sep + 1);
const timeoutMs = Number(process.env.REDLINE_LOCAL_TIMEOUT_MS) || 15 * 60_000;

let pair: LocalPair | null = null;
let runPid: number | undefined;
let finishing = false;

async function finish(code: number, why?: string): Promise<never> {
  if (!finishing) {
    finishing = true;
    if (why) console.error(`local-pair: ${why}`);
    if (runPid) {
      try {
        process.kill(-runPid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 30 && groupMembers(runPid).length; i++)
        await new Promise((r) => setTimeout(r, 100));
    }
    const spawned = [...(pair?.pids ?? []), ...(runPid ? [runPid] : [])];
    const left = pair ? await pair.stop() : [];
    const runLeft = runPid ? groupMembers(runPid) : [];
    console.log(
      `local-pair: spawned groups ${spawned.join(" ") || "none"}; left after teardown: ${[...left, ...runLeft].join(" ") || "none"}`,
    );
    if (left.length || runLeft.length) code = code || 1;
  }
  process.exit(code);
}

// Last resort if the loop dies without finish(): SIGKILL our groups, synchronously.
process.on("exit", () => {
  for (const p of [...(pair?.pids ?? []), ...(runPid ? [runPid] : [])]) {
    try {
      process.kill(-p, "SIGKILL");
    } catch {}
  }
});
process.on("SIGINT", () => void finish(130, "SIGINT"));
process.on("SIGTERM", () => void finish(143, "SIGTERM"));
const timer = setTimeout(() => void finish(124, "timed out"), timeoutMs);

try {
  pair = await startLocalPair();
  console.log(
    `local-pair: ${pair.installs.map((i) => `${i.name} app ${i.app} content ${i.content}`).join("; ")}`,
  );
  const [bin = "", ...args] = cmd;
  const child = spawn(bin, args, {
    stdio: "inherit",
    detached: true,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      REDLINE_TARGETS: pair.targets,
      ...(process.env.REDLINE_GATE
        ? { REDLINE_GATE: process.env.REDLINE_GATE }
        : {}),
      ...(process.env.REDLINE_REPORT
        ? { REDLINE_REPORT: process.env.REDLINE_REPORT }
        : {}),
    },
  });
  runPid = child.pid;
  const code: number = await new Promise((res) =>
    child.on("exit", (c, s) => res(c ?? (s ? 1 : 0))),
  );
  clearTimeout(timer);
  await finish(code);
} catch (e) {
  clearTimeout(timer);
  await finish(1, e instanceof Error ? e.message : "failed");
}
