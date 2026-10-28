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
  localModeOf,
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
let booting: Promise<LocalPair> | null = null;
let finishing: Promise<never> | null = null;
/** Every group spawned (for the report). */
const spawnedPids: number[] = [];
/** Groups not yet confirmed empty: the only ones ever signalled. */
const live = new Set<number>();
/** The command's group, while live. */
let runPid: number | undefined;
const abort = new AbortController();

/** Idempotent: the first caller tears down and exits; later callers wait. */
function finish(code: number, why?: string): Promise<never> {
  finishing ??= teardown(code, why);
  return finishing;
}

const groupGone = (pg: number) => groupMembers(pg).length === 0;

async function teardown(code: number, why?: string): Promise<never> {
  if (why) console.error(`local-pair: ${why}`);
  if (!pair && booting) {
    // Mid-boot: abort, and startLocalPair stops and removes what it made.
    abort.abort();
    pair = await booting.catch(() => null);
  }
  if (runPid && live.has(runPid)) {
    if (!groupGone(runPid)) {
      try {
        process.kill(-runPid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 30 && !groupGone(runPid); i++)
        await new Promise((r) => setTimeout(r, 100));
      if (!groupGone(runPid))
        try {
          process.kill(-runPid, "SIGKILL");
        } catch {}
    }
    if (groupGone(runPid)) live.delete(runPid);
  }
  const left = pair ? await pair.stop() : [];
  for (const p of [...live]) if (groupGone(p)) live.delete(p);
  const all = [...spawnedPids, ...(runPid ? [runPid] : [])];
  console.log(
    `local-pair: spawned groups ${all.join(" ") || "none"}; left after teardown: ${[...new Set([...left, ...[...live].flatMap(groupMembers)])].join(" ") || "none"}`,
  );
  if (left.length || live.size) code = code || 1;
  process.exit(code);
}

// Last resort if the loop dies without finish(): SIGKILL still-live groups only.
process.on("exit", () => {
  for (const p of live) {
    try {
      process.kill(-p, "SIGKILL");
    } catch {}
  }
});
process.on("SIGINT", () => void finish(130, "SIGINT"));
process.on("SIGTERM", () => void finish(143, "SIGTERM"));
process.on("SIGHUP", () => void finish(129, "SIGHUP"));
const timer = setTimeout(() => void finish(124, "timed out"), timeoutMs);

try {
  booting = startLocalPair({
    // REDLINE_LOCAL_MODE=google: the sync_frozen / sync_google tiers.
    mode: localModeOf(),
    signal: abort.signal,
    onSpawn: (p) => {
      spawnedPids.push(p);
      live.add(p);
    },
    onReap: (p) => live.delete(p),
  });
  pair = await booting;
  if (finishing) await finishing;
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
      // Inside the pair's temp dir unless given, so teardown removes it too.
      REDLINE_REPORT:
        process.env.REDLINE_REPORT || join(pair.dir, "report.json"),
    },
  });
  runPid = child.pid;
  if (runPid) live.add(runPid);
  const code: number = await new Promise((res) =>
    child.on("exit", (c, s) => res(c ?? (s ? 1 : 0))),
  );
  clearTimeout(timer);
  await finish(code);
} catch (e) {
  clearTimeout(timer);
  await finish(1, e instanceof Error ? e.message : "failed");
}
