// The real-tenant sign-in step (P5 R6, staging, macOS). Runbook:
// docs/ops/redline-signin.md.
//   REDLINE_TARGETS=... node --experimental-strip-types scripts/signin-capture.ts [--gate]
// For each flow in CAPTURE_FLOWS: starts a sign-in at the install (the state
// cookie stays in a 0700 temp dir, never the browser), puts the sign-in URL on
// the clipboard, waits while the user signs in as the named test user and
// copies the callback request URL, then reads it from the clipboard into a
// 0600 file and clears the clipboard. Nothing is printed but flow names,
// users and verdicts. Then runs the live suite with REDLINE_SIGNIN_CAPTURES
// and removes the directory.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  CALLBACK_GOOGLE,
  CAPTURE_FLOWS,
  type FlowName,
  type StartedFlow,
  startGoogle,
} from "../src/signin.ts";
import { loadTargets } from "../src/targets.ts";

const T = await loadTargets();
if (T.mode !== "staging") {
  console.error("signin-capture: staging targets only");
  process.exit(2);
}
const copy = (s: string) => execFileSync("pbcopy", { input: s });
const paste = () => execFileSync("pbpaste", { encoding: "utf8" }).trim();

const dir = mkdtempSync(join(tmpdir(), "oa-redline-signin-"));
const rl = createInterface({ input: process.stdin, output: process.stdout });
const flows: StartedFlow[] = [];
let code = 1;
try {
  for (const [flow, spec] of Object.entries(CAPTURE_FLOWS)) {
    const t = T[spec.at];
    const s = await startGoogle(t);
    if (!s) throw new Error(`Google sign-in is off on ${t.name}`);
    flows.push({
      flow: flow as FlowName,
      at: spec.at,
      state: s.state,
      cookie: s.cookie,
      startedAt: Date.now(),
    });
    copy(s.location.toString());
    for (;;) {
      await rl.question(
        `\n[${flows.length}/${Object.keys(CAPTURE_FLOWS).length}] Sign in as ${spec.user}.\n` +
          "  The sign-in URL is on the clipboard: paste it into the address bar of the\n" +
          "  window with DevTools open, sign in, then copy the callback request URL.\n" +
          "  Press Enter when it is copied. ",
      );
      let u: URL | null = null;
      try {
        u = new URL(paste());
      } catch {}
      if (
        u?.origin === t.app &&
        u.pathname === CALLBACK_GOOGLE &&
        u.searchParams.get("state") === s.state &&
        u.searchParams.get("code")
      ) {
        writeFileSync(join(dir, `${flow}.url`), u.toString(), { mode: 0o600 });
        copy("");
        console.log(`  ${flow}: captured.`);
        break;
      }
      console.log(
        `  ${flow}: the clipboard isn't this flow's ${t.name} callback URL (with a code). Copy it again.`,
      );
    }
  }
  writeFileSync(join(dir, "flows.json"), JSON.stringify(flows), {
    mode: 0o600,
  });
  rl.close();
  const gate = process.argv.includes("--gate") ? ["--gate"] : [];
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(import.meta.dirname, "redline.ts"),
      ...gate,
    ],
    {
      stdio: "inherit",
      env: { ...process.env, REDLINE_SIGNIN_CAPTURES: dir },
    },
  );
  code = await new Promise((r) => child.on("exit", (c) => r(c ?? 1)));
} catch (e) {
  console.error(`signin-capture: ${e instanceof Error ? e.message : "failed"}`);
} finally {
  rl.close();
  try {
    copy("");
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
