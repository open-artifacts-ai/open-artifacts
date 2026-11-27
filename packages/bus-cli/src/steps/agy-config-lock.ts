// Lamport's bakery lock. Each installer publishes its own ticket; no process
// removes or replaces a live peer's ticket. The config is shared by bus homes.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as retryAfter } from "node:timers/promises";
import { procStartOf } from "@oa/bus-adapter-claude-code";

const prefix = ".oa-bus-agy-ticket.";
const ticketName =
  /^\.oa-bus-agy-ticket\.(\d+)\.([a-f0-9]{16}|unknown)\.[a-f0-9-]{36}$/;
const birth = (pid: number) => {
  const start = procStartOf(pid);
  return start
    ? createHash("sha256").update(start).digest("hex").slice(0, 16)
    : "unknown";
};
function abandoned(pid: number, start: string) {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
  const actual = start === "unknown" ? start : birth(pid);
  return actual !== "unknown" && actual !== start;
}

function tickets(dir: string) {
  const list: { name: string; number: number }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const match = ticketName.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    try {
      const [number] = readdirSync(path);
      if (abandoned(Number(match[1]), match[2])) {
        if (number && /^\d+$/.test(number)) rmdirSync(join(path, number));
        rmdirSync(path);
      } else list.push({ name, number: Number(number ?? 0) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return list;
}

export async function withAgyConfigLock<T>(
  dir: string,
  work: () => T | Promise<T>,
): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const name = `${prefix}${process.pid}.${birth(process.pid)}.${randomUUID()}`;
  const path = join(dir, name);
  mkdirSync(path, { mode: 0o700 }); // visible while selecting a number
  let numbered: string | undefined;
  try {
    const number =
      tickets(dir).reduce((max, t) => Math.max(max, t.number), 0) + 1;
    const selected = join(path, String(number));
    mkdirSync(selected, { mode: 0o700 });
    numbered = selected;
    for (let attempt = 0; ; attempt++) {
      const busy = tickets(dir).some(
        (t) =>
          t.name !== name &&
          (t.number < number || (t.number === number && t.name < name)),
      );
      if (!busy) return await work();
      if (attempt >= 100)
        throw new Error(
          `Concurrent Antigravity config update at ${dir}; retry the command.`,
        );
      await retryAfter(Math.min(10 * 2 ** attempt, 200)); // backoff only after a contended acquisition
    }
  } finally {
    if (numbered) rmdirSync(numbered);
    rmdirSync(path);
  }
}
