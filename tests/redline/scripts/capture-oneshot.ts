// The one-shot real-tenant sign-in capture (P5 R6, staging, macOS):
//   pnpm -C tests/redline capture [--make-creds]
//   pnpm -C tests/redline capture:dry-run
// Runbook: docs/ops/redline-signin.md. Everything is in src/oneshot/driver.ts;
// this is its terminal: keys, questions, and cleanup on every exit path.
import { createInterface } from "node:readline/promises";
import { cleanupSync, oneShot } from "../src/oneshot/driver.ts";

let suitePid: number | undefined;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => {
    if (suitePid)
      try {
        process.kill(suitePid, sig);
      } catch {}
    cleanupSync();
    process.exit(130);
  });
process.on("exit", () => cleanupSync());

/** One key in raw mode; Ctrl-C is a SIGINT. "" without a terminal. */
function key(): Promise<string> {
  const i = process.stdin;
  if (!i.isTTY) return Promise.resolve("");
  i.setRawMode(true);
  i.resume();
  return new Promise((r) =>
    i.once("data", (d) => {
      i.setRawMode(false);
      i.pause();
      const k = d.toString("utf8");
      if (k === "\u0003") process.kill(process.pid, "SIGINT");
      r(k.toLowerCase());
    }),
  );
}

async function question(q: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // readline turns Ctrl-C into its own event: send it down the same scrub path.
  rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

const code = await oneShot(process.argv.slice(2), {
  env: process.env,
  out: (l) => console.log(l),
  key,
  question,
  onSuite: (pid) => {
    suitePid = pid;
  },
});
cleanupSync();
process.exit(code);
