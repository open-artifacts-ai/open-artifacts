// The one-shot real-tenant sign-in capture (P5 R6, staging, macOS):
//   pnpm -C tests/redline capture [--make-creds]
// Runbook: docs/ops/redline-signin.md. Everything is in src/oneshot/driver.ts;
// this is its terminal: keys, questions, and cleanup on every exit path.
import { createInterface } from "node:readline/promises";
import { cleanupSync, oneShot } from "../src/oneshot/driver.ts";

let suitePid: number | undefined;
/** 128 + the signal's number. */
const EXIT_BY_SIGNAL = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => {
    if (suitePid)
      try {
        process.kill(suitePid, sig);
      } catch {}
    cleanupSync();
    process.exit(EXIT_BY_SIGNAL[sig]);
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
  // Tests only: where the run dir goes (default ~/.open-artifacts/redline-capture).
  ...(process.env.OA_REDLINE_RUN_BASE
    ? { runBase: process.env.OA_REDLINE_RUN_BASE }
    : {}),
  out: (l) => console.log(l),
  key,
  question,
  onSuite: (pid) => {
    suitePid = pid;
  },
});
cleanupSync();
process.exit(code);
