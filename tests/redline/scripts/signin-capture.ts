// The real-tenant sign-in step (P5 R6, staging, macOS). Runbook:
// docs/ops/redline-signin.md.
//   REDLINE_TARGETS=... node --experimental-strip-types scripts/signin-capture.ts [--gate]
// The interactive shell of src/capture.ts (the rehearsal drives the same code
// against a fake IdP: test/rehearsal.test.ts). First the preflight
// (src/preflight.ts): it refuses to start and names each gap. Then for each
// flow: the sign-in URL goes on the clipboard, the user signs in as the named
// test user and copies the FIRST callback URL; the script checks it, clears
// the clipboard and redeems it at once, recording each leg's verdict (with a
// redacted reason) in a 0600 verdicts file in a 0700 temp dir. Then it runs
// the live suite with REDLINE_SIGNIN_CAPTURES and removes the directory.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { runCaptures } from "../src/capture.ts";
import { formatPreflight, gaps, preflight } from "../src/preflight.ts";

const copy = (s: string): void => {
  execFileSync("pbcopy", { input: s });
};
const paste = () => execFileSync("pbpaste", { encoding: "utf8" }).trim();

const { checks, targets: T } = await preflight(process.env);
process.stdout.write(`Preflight:\n${formatPreflight(checks)}`);
if (!T || gaps(checks).length > 0) process.exit(2);
if (T.mode !== "staging") {
  console.error("signin-capture: staging targets only");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "oa-redline-signin-"));
const rl = createInterface({ input: process.stdin, output: process.stdout });
let child: ChildProcess | null = null;

/** Clears the clipboard and removes the verdicts; safe to call twice. */
function scrub(): void {
  try {
    copy("");
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}

// Ctrl-C (or a kill) at any point, prompts or the suite run after them:
// forward to the suite, scrub, exit. Registered before anything is captured.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => {
    if (child?.exitCode === null) child.kill(sig);
    scrub();
    process.exit(130);
  });
// readline turns Ctrl-C at a prompt into its own SIGINT event.
rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
let code = 1;
try {
  await runCaptures(T, dir, {
    offer: (url) => copy(url.toString()),
    async ask(p) {
      await rl.question(
        `\n[${p.n}/${p.total}] ${p.install}: sign in as ${p.user}.\n` +
          `  ${p.why}\n` +
          (p.retry ? `  (Again: ${p.retry}.)\n` : "") +
          "  The sign-in URL is on the clipboard: paste it into the address bar of the\n" +
          "  window with DevTools open, sign in, then copy the FIRST callback request URL\n" +
          "  (its state doesn't start with r1.). The browser then retries on its own and\n" +
          "  may show a second Google screen or sign in: close or ignore it.\n" +
          "  Press Enter when it is copied. ",
      );
      return paste();
    },
    taken: () => copy(""),
    say: (l) => console.log(l),
  });
  rl.close();
  const gate = process.argv.includes("--gate") ? ["--gate"] : [];
  child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(import.meta.dirname, "redline.ts"),
      ...gate,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        REDLINE_SIGNIN_CAPTURES: dir,
        REDLINE_CAPTURE_RUN: "1",
      },
    },
  );
  const run = child;
  code = await new Promise((r) => run.on("exit", (c) => r(c ?? 1)));
} catch (e) {
  console.error(`signin-capture: ${e instanceof Error ? e.message : "failed"}`);
} finally {
  rl.close();
  scrub();
}
process.exit(code);
